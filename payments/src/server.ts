// Payment service entry point: `npm start --workspace @curb/payments`.

import { paymentMiddlewareFromHTTPServer } from "@x402/express";

import { createBookingApi } from "./apiClient.js";
import { createCdpGateway, createReceiptServer, createWalletApi, RECEIPT_ROUTE } from "./cdp.js";
import { createOrchestrator } from "./orchestrator.js";
import { createApp } from "./routes.js";
import { MemoryPaymentStore } from "./types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see payments/.env.example`);
  return value;
}

const port = Number(process.env.PORT ?? 8787);
const serviceToken = required("CURB_PAYMENT_SERVICE_TOKEN");
const api = createBookingApi(required("CURB_API_URL"), serviceToken);
for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) required(name);

const gateway = createCdpGateway(
  {
    perPaymentUsdc: process.env.CURB_SPEND_PER_PAYMENT_USDC ?? "10",
    dailyUsdc: process.env.CURB_SPEND_DAILY_USDC ?? "50",
  },
  serviceToken,
);
const receipts = await createReceiptServer(async (bookingId) => (await api.getBooking(bookingId)).amount_usdc);
const payee = receipts.payTo;
if (!payee) throw new Error("owner wallet was not provisioned");

const orchestrator = createOrchestrator({
  api,
  gateway,
  store: new MemoryPaymentStore(),
  resourceUrl: (id) => `http://127.0.0.1:${port}${RECEIPT_ROUTE.replace(":bookingId", encodeURIComponent(id))}`,
  explorerUrl: (tx) => `https://sepolia.basescan.org/tx/${tx}`,
});

const app = createApp({
  orchestrator,
  api,
  wallet: createWalletApi(),
  serviceToken,
  payeeAddress: () => payee,
  paywall: paymentMiddlewareFromHTTPServer(receipts.httpServer),
});

const { evmAddress } = await gateway.client.getAddresses();
app.listen(port, () => {
  console.log(`[payments] listening on :${port}`);
  console.log(`[payments] driver wallet (payer): ${evmAddress}`);
  console.log(`[payments] owner wallet (payee):  ${payee}`);
});
