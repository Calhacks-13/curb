// Coinbase CDP + x402 adapter. Both wallets are stable, named CDP Server Wallets
// on Base Sepolia: the driver pays from "curb-demo-driver" and the owner is paid
// at "curb-demo-owner". CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET
// come from the environment.

import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client, createX402Server } from "@coinbase/cdp-sdk/x402";
import type { x402Client } from "@x402/core/client";
import type { HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";

import type { PaymentGateway, SettlementEvidence, WalletApi } from "./types.js";

export const NETWORK = "eip155:84532"; // Base Sepolia
export const DRIVER_WALLET = "curb-demo-driver";
export const OWNER_WALLET = "curb-demo-owner";
export const BUILDER_CODE = "curb_demo";
/** Circle's USDC on Base Sepolia. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const RECEIPT_ROUTE = "/v1/x402/bookings/:bookingId";
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const explorerAddress = (address: string) => `https://sepolia.basescan.org/address/${address}`;
const explorerTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

const usdcAtomic = (usdc: string) => BigInt(Math.round(Number(usdc) * 1_000_000));

export type SpendLimits = { perPaymentUsdc: string; dailyUsdc: string };

export function createCdpGateway(limits: SpendLimits, serviceToken: string): PaymentGateway & { client: CdpX402Client } {
  const client = new CdpX402Client({
    environment: "development",
    walletConfig: { type: "eoa", accountName: DRIVER_WALLET },
    builderCode: BUILDER_CODE,
    spendControls: {
      maxAmountPerPayment: { atomic: usdcAtomic(limits.perPaymentUsdc), asset: USDC_BASE_SEPOLIA },
      maxCumulativeSpend: { atomic: usdcAtomic(limits.dailyUsdc), asset: USDC_BASE_SEPOLIA },
      maxCumulativeSpendWindow: "24h",
      allowedNetworks: [NETWORK],
    },
  });
  // The SDK's types see @x402/core's CommonJS declarations and ours see the ESM
  // ones; at runtime both are the same module.
  const payingFetch = wrapFetchWithPayment(fetch, client as unknown as x402Client);
  // One client serves every booking, so signing callbacks are keyed by resource URL.
  const onSignedByUrl = new Map<string, () => void>();
  (client as unknown as x402Client).onAfterPaymentCreation(async (ctx) => {
    const url = ctx.paymentRequired.resource?.url;
    if (url) onSignedByUrl.get(url)?.();
  });

  return {
    client,
    async pay(resourceUrl, idempotencyKey, onSigned): Promise<SettlementEvidence> {
      if (onSigned) onSignedByUrl.set(resourceUrl, onSigned);
      let res: Response;
      try {
        res = await payingFetch(resourceUrl, {
          headers: { Authorization: `Bearer ${serviceToken}`, "Idempotency-Key": idempotencyKey },
        });
      } finally {
        onSignedByUrl.delete(resourceUrl);
      }
      if (!res.ok) throw Object.assign(new Error(`receipt returned ${res.status}`), { code: `RECEIPT_${res.status}` });
      const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      if (!header) throw Object.assign(new Error("no settlement header"), { code: "NO_SETTLEMENT" });
      const settle = decodePaymentResponseHeader(header);
      if (!settle.success || !settle.transaction) {
        throw Object.assign(new Error(settle.errorReason ?? "settlement failed"), { code: "SETTLEMENT_FAILED" });
      }
      return {
        transactionHash: settle.transaction,
        network: settle.network,
        payer: settle.payer ?? null,
        settledAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * x402 resource server for the booking receipt. Price comes from the held
 * booking (never the request), and the owner wallet is the only payee.
 */
export async function createReceiptServer(priceFor: (bookingId: string) => Promise<string>) {
  const bookingIdOf = (ctx: HTTPRequestContext) => decodeURIComponent(ctx.path.split("/").filter(Boolean).pop() ?? "");
  const server = await createX402Server({
    environment: "development",
    payToConfig: { type: "eoa", accountName: OWNER_WALLET },
    builderCode: BUILDER_CODE,
    routes: {
      [`GET ${RECEIPT_ROUTE}`]: {
        description: "Curb driveway booking receipt",
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: "",
          price: async (ctx: HTTPRequestContext) => `$${await priceFor(bookingIdOf(ctx))}`,
        },
      },
    },
  });
  // Same CommonJS/ESM declaration split as the client above.
  return { httpServer: server as unknown as x402HTTPResourceServer, payTo: server.payToEvmAddress };
}

async function usdcBalance(address: string): Promise<string> {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0"); // balanceOf(address)
  const res = await fetch(BASE_SEPOLIA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE_SEPOLIA, data }, "latest"] }),
  });
  const { result } = (await res.json()) as { result?: string };
  const atomic = BigInt(result && result !== "0x" ? result : "0x0");
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The two named demo wallets: who pays, who's paid, and the payer's balance. */
export function createWalletApi(): WalletApi {
  const cdp = new CdpClient();
  const accounts = Promise.all([
    cdp.evm.getOrCreateAccount({ name: DRIVER_WALLET }),
    cdp.evm.getOrCreateAccount({ name: OWNER_WALLET }),
  ]);
  return {
    async info() {
      const [driver, owner] = await accounts;
      return {
        network: "base-sepolia",
        payer: {
          name: DRIVER_WALLET,
          address: driver.address,
          usdc_balance: await usdcBalance(driver.address),
          explorer_url: explorerAddress(driver.address),
        },
        payee: { name: OWNER_WALLET, address: owner.address },
      };
    },
    async topUp() {
      const [driver] = await accounts;
      const { transactionHash } = await cdp.evm.requestFaucet({ address: driver.address, network: "base-sepolia", token: "usdc" });
      return { transaction_hash: transactionHash, explorer_url: explorerTx(transactionHash) };
    },
  };
}
