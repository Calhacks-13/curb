// Coinbase CDP + x402 adapter. Both wallets are stable, named CDP Server Wallets
// on Base Sepolia: the driver pays from "curb-demo-driver" and the owner is paid
// at "curb-demo-owner". CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET
// come from the environment.

import { CdpX402Client, createX402Server } from "@coinbase/cdp-sdk/x402";
import type { x402Client } from "@x402/core/client";
import type { HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";

import type { PaymentGateway, SettlementEvidence } from "./types.js";

export const NETWORK = "eip155:84532"; // Base Sepolia
export const DRIVER_WALLET = "curb-demo-driver";
export const OWNER_WALLET = "curb-demo-owner";
export const BUILDER_CODE = "curb_demo";
/** Circle's USDC on Base Sepolia. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const RECEIPT_ROUTE = "/v1/x402/bookings/:bookingId";

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

  return {
    client,
    async pay(resourceUrl, idempotencyKey): Promise<SettlementEvidence> {
      const res = await payingFetch(resourceUrl, {
        headers: { Authorization: `Bearer ${serviceToken}`, "Idempotency-Key": idempotencyKey },
      });
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
