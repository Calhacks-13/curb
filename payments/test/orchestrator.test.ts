import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/apiClient.js";
import { createOrchestrator, PaymentError } from "../src/orchestrator.js";
import { MemoryPaymentStore } from "../src/types.js";
import { fakeApi, fakeGateway, heldBooking, TX } from "./fakes.js";

function setup(api = fakeApi(), gateway = fakeGateway()) {
  const store = new MemoryPaymentStore();
  const orchestrator = createOrchestrator({
    api: api.api,
    gateway,
    store,
    resourceUrl: (id) => `http://payments.test/v1/x402/bookings/${id}`,
    explorerUrl: (tx) => `https://sepolia.basescan.org/tx/${tx}`,
  });
  return { ...api, gateway, store, orchestrator };
}

describe("executePayment", () => {
  it("marks processing, settles once, finalizes with the tx hash, and confirms", async () => {
    const { api, gateway, orchestrator } = setup();
    const result = await orchestrator.executePayment("booking_1", "demo-token-driver_demo");

    expect(api.getBooking).toHaveBeenCalledWith("booking_1", "demo-token-driver_demo");
    expect(api.markProcessing).toHaveBeenCalledWith("booking_1", 1);
    expect(gateway.pay).toHaveBeenCalledWith("http://payments.test/v1/x402/bookings/booking_1", "idem_1", expect.any(Function));
    expect(api.finalize).toHaveBeenCalledWith("booking_1", "idem_1", TX, 2);
    expect(result.booking.state).toBe("CONFIRMED");
    expect(result.explorer_url).toBe(`https://sepolia.basescan.org/tx/${TX}`);
  });

  it("returns the same transaction on a repeat call without paying again", async () => {
    const { gateway, orchestrator } = setup();
    const first = await orchestrator.executePayment("booking_1");
    const again = await orchestrator.executePayment("booking_1");
    expect(gateway.pay).toHaveBeenCalledTimes(1);
    expect(again.booking.transaction_hash).toBe(first.booking.transaction_hash);
  });

  it("shares one attempt between concurrent calls", async () => {
    const { gateway, orchestrator } = setup();
    const [a, b] = await Promise.all([orchestrator.executePayment("booking_1"), orchestrator.executePayment("booking_1")]);
    expect(gateway.pay).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe("partial failure and retry", () => {
  it("records reconciliation when settlement succeeds but finalize fails", async () => {
    const { api, store, orchestrator } = setup();
    api.finalize.mockRejectedValueOnce(new ApiError(503, "down"));
    const result = await orchestrator.executePayment("booking_1");

    expect(result.booking.state).toBe("RECONCILIATION_REQUIRED");
    expect(result.booking.transaction_hash).toBe(TX);
    expect(store.get("booking_1")).toMatchObject({ reconciliationRequired: true, evidence: { transactionHash: TX } });
  });

  it("retries only the finalize, reusing stored evidence", async () => {
    const { api, gateway, store, orchestrator } = setup();
    api.finalize.mockRejectedValueOnce(new ApiError(503, "down"));
    await orchestrator.executePayment("booking_1");
    const retried = await orchestrator.executePayment("booking_1");

    expect(gateway.pay).toHaveBeenCalledTimes(1);
    expect(api.markProcessing).toHaveBeenCalledTimes(1);
    expect(api.finalize).toHaveBeenCalledTimes(2);
    expect(retried.booking.state).toBe("CONFIRMED");
    expect(store.get("booking_1")?.reconciliationRequired).toBe(false);
  });

  it("treats a finalize that landed behind a lost response as confirmed", async () => {
    const api = fakeApi();
    const { orchestrator } = setup(api);
    api.api.finalize.mockImplementationOnce(async () => {
      api.set(heldBooking({ state: "CONFIRMED", payment_status: "SETTLED", transaction_hash: TX, version: 3 }));
      throw new ApiError(409, "already finalized");
    });
    const result = await orchestrator.executePayment("booking_1");
    expect(result.booking.state).toBe("CONFIRMED");
  });

  it("returns a failed settlement to a retryable held checkout", async () => {
    const gateway = fakeGateway();
    gateway.pay.mockRejectedValueOnce(Object.assign(new Error("insufficient funds"), { code: "INSUFFICIENT_FUNDS" }));
    const { api, current, orchestrator } = setup(fakeApi(), gateway);

    const failure = await orchestrator.executePayment("booking_1").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PaymentError);
    expect(failure).toMatchObject({ status: 402, code: "INSUFFICIENT_FUNDS", retryable: true });
    expect(api.markFailed).toHaveBeenCalledWith("booking_1", 2, "INSUFFICIENT_FUNDS", true);
    expect(api.finalize).not.toHaveBeenCalled();
    expect(current().state).toBe("PENDING_PAYMENT");

    const retried = await orchestrator.executePayment("booking_1");
    expect(retried.booking.state).toBe("CONFIRMED");
    expect(gateway.pay).toHaveBeenCalledTimes(2);
  });

  it("never pays when the hold changed before processing (owner recovery won)", async () => {
    const { api, gateway, orchestrator } = setup();
    api.markProcessing.mockRejectedValueOnce(new ApiError(409, "recovered by owner"));
    await expect(orchestrator.executePayment("booking_1")).rejects.toMatchObject({ status: 409, code: "BOOKING_CHANGED" });
    expect(gateway.pay).not.toHaveBeenCalled();
  });

  it("refuses a cancelled booking", async () => {
    const { gateway, orchestrator } = setup(fakeApi(heldBooking({ state: "CANCELLED" })));
    await expect(orchestrator.executePayment("booking_1")).rejects.toMatchObject({ status: 409, code: "BOOKING_CANCELLED" });
    expect(gateway.pay).not.toHaveBeenCalled();
  });

  it("does not let a reported failure hide the payment error", async () => {
    const gateway = fakeGateway();
    gateway.pay.mockRejectedValueOnce(new Error("network"));
    const { api, orchestrator } = setup(fakeApi(), gateway);
    api.markFailed.mockRejectedValueOnce(new ApiError(503, "down"));
    await expect(orchestrator.executePayment("booking_1")).rejects.toMatchObject({ status: 402, code: "PAYMENT_FAILED" });
    vi.restoreAllMocks();
  });
});

describe("checkout progress", () => {
  it("walks approved, signed, settled, confirmed", async () => {
    const seen: string[] = [];
    const api = fakeApi();
    const gateway = fakeGateway();
    const { orchestrator } = setup(api, gateway);
    gateway.pay.mockImplementationOnce(async (_url, _key, onSigned) => {
      seen.push(orchestrator.progress("booking_1")!.phase);
      onSigned?.();
      seen.push(orchestrator.progress("booking_1")!.phase);
      return { transactionHash: TX, network: "eip155:84532", payer: null, settledAt: "" };
    });
    api.api.finalize.mockImplementationOnce(async () => {
      seen.push(orchestrator.progress("booking_1")!.phase);
      return { ...api.current(), state: "CONFIRMED", transaction_hash: TX, version: 3 };
    });
    await orchestrator.executePayment("booking_1");
    seen.push(orchestrator.progress("booking_1")!.phase);
    expect(seen).toEqual(["approved", "signed", "settled", "confirmed"]);
  });

  it("records the failure code", async () => {
    const gateway = fakeGateway();
    gateway.pay.mockRejectedValueOnce(Object.assign(new Error("no funds"), { code: "RECEIPT_402" }));
    const { orchestrator } = setup(fakeApi(), gateway);
    await orchestrator.executePayment("booking_1").catch(() => {});
    expect(orchestrator.progress("booking_1")).toMatchObject({ phase: "failed", error_code: "RECEIPT_402" });
  });
});
