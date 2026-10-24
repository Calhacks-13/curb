import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOrchestrator } from "../src/orchestrator.js";
import { createApp } from "../src/routes.js";
import { MemoryPaymentStore } from "../src/types.js";
import { fakeApi, fakeGateway, fakeWallet, heldBooking, TX } from "./fakes.js";

const SERVICE = "service-secret";
let server: Server | null = null;

async function start(api = fakeApi(), gateway = fakeGateway(), wallet = fakeWallet()) {
  const orchestrator = createOrchestrator({
    api: api.api,
    gateway,
    store: new MemoryPaymentStore(),
    resourceUrl: (id) => `http://payments.test/v1/x402/bookings/${id}`,
    explorerUrl: (tx) => `https://sepolia.basescan.org/tx/${tx}`,
  });
  const app = createApp({ orchestrator, api: api.api, wallet, serviceToken: SERVICE, payeeAddress: () => "0xowner" });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, api, gateway, wallet };
}

afterEach(() => {
  server?.close();
  server = null;
});

const post = (url: string, token?: string) =>
  fetch(url, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("POST /v1/payments/:id/execute", () => {
  it("requires the driver's token and passes it on for the ownership check", async () => {
    const { base, api } = await start();
    expect((await post(`${base}/v1/payments/booking_1/execute`)).status).toBe(401);

    const res = await post(`${base}/v1/payments/booking_1/execute`, "demo-token-driver_demo");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking.state).toBe("CONFIRMED");
    expect(body.explorer_url).toBe(`https://sepolia.basescan.org/tx/${TX}`);
    expect(api.api.getBooking).toHaveBeenCalledWith("booking_1", "demo-token-driver_demo");
  });

  it("answers 202 while a settled payment awaits reconciliation", async () => {
    const api = fakeApi();
    api.api.finalize.mockRejectedValueOnce(new Error("down"));
    const { base } = await start(api);
    const res = await post(`${base}/v1/payments/booking_1/execute`, "demo-token-driver_demo");
    expect(res.status).toBe(202);
    expect((await res.json()).booking.state).toBe("RECONCILIATION_REQUIRED");
  });

  it("reports a failed payment as retryable with the held booking", async () => {
    const gateway = fakeGateway();
    gateway.pay.mockRejectedValueOnce(Object.assign(new Error("no funds"), { code: "INSUFFICIENT_FUNDS" }));
    const { base } = await start(fakeApi(), gateway);
    const res = await post(`${base}/v1/payments/booking_1/execute`, "demo-token-driver_demo");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "INSUFFICIENT_FUNDS", retryable: true, booking: { state: "PENDING_PAYMENT" } });
  });

  it("passes through the server's ownership refusal", async () => {
    const api = fakeApi();
    const { ApiError } = await import("../src/apiClient.js");
    api.api.getBooking.mockRejectedValueOnce(new ApiError(403, "not your booking"));
    const { base, gateway } = await start(api);
    const res = await post(`${base}/v1/payments/booking_1/execute`, "demo-token-owner_demo");
    expect(res.status).toBe(403);
    expect(gateway.pay).not.toHaveBeenCalled();
  });
});

describe("GET /v1/x402/bookings/:id", () => {
  it("is reserved for the payment service", async () => {
    const { base } = await start(fakeApi(heldBooking({ state: "PROCESSING", version: 2 })));
    const res = await fetch(`${base}/v1/x402/bookings/booking_1`, { headers: { Authorization: "Bearer demo-token-driver_demo" } });
    expect(res.status).toBe(403);
  });

  it("only serves a booking that is processing", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/x402/bookings/booking_1`, { headers: { Authorization: `Bearer ${SERVICE}` } });
    expect(res.status).toBe(409);
  });

  it("returns only non-secret receipt fields, priced from the held booking", async () => {
    const { base } = await start(fakeApi(heldBooking({ state: "PROCESSING", version: 2 })));
    const res = await fetch(`${base}/v1/x402/bookings/booking_1?amount=0.01`, { headers: { Authorization: `Bearer ${SERVICE}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      booking_id: "booking_1",
      driveway_id: "driveway_demo_1",
      amount_usdc: "4.00",
      network: "base-sepolia",
      payee_address: "0xowner",
    });
  });
});

describe("wallet and progress", () => {
  const auth = { Authorization: "Bearer demo-token-driver_demo" };

  it("shows the payer wallet and balance to a signed-in driver only", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/wallet`)).status).toBe(401);
    const res = await fetch(`${base}/v1/wallet`, { headers: auth });
    expect(await res.json()).toMatchObject({ payer: { address: "0xdriver", usdc_balance: "9.25" }, payee: { address: "0xowner" } });
  });

  it("tops up from the faucet, and reports a rate limit as 429", async () => {
    const wallet = fakeWallet();
    const { base } = await start(fakeApi(), fakeGateway(), wallet);
    const ok = await fetch(`${base}/v1/wallet/top-up`, { method: "POST", headers: auth });
    expect(await ok.json()).toMatchObject({ transaction_hash: "0xfaucet" });

    wallet.topUp.mockRejectedValueOnce(new Error("rate limited"));
    const limited = await fetch(`${base}/v1/wallet/top-up`, { method: "POST", headers: auth });
    expect(limited.status).toBe(429);
  });

  it("reports the checkout phase after a payment", async () => {
    const { base } = await start();
    const before = await (await fetch(`${base}/v1/payments/booking_1`, { headers: auth })).json();
    expect(before.phase).toBeNull();

    await post(`${base}/v1/payments/booking_1/execute`, "demo-token-driver_demo");
    const after = await (await fetch(`${base}/v1/payments/booking_1`, { headers: auth })).json();
    expect(after).toMatchObject({ phase: "confirmed", transaction_hash: TX, explorer_url: `https://sepolia.basescan.org/tx/${TX}` });
  });
});
