import { vi } from "vitest";

import { ApiError } from "../src/apiClient.js";
import type { Booking, BookingApi, PaymentGateway, SettlementEvidence, WalletApi } from "../src/types.js";

export const TX = "0xabc123";

export function heldBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking_1",
    idempotency_key: "idem_1",
    driveway_id: "driveway_demo_1",
    driver_id: "driver_demo",
    state: "PENDING_PAYMENT",
    payment_status: "NOT_STARTED",
    amount_usdc: "4.00",
    network: "base-sepolia",
    transaction_hash: null,
    created_at: "2026-10-24T18:00:00Z",
    confirmed_at: null,
    version: 1,
    ...overrides,
  };
}

/** In-memory stand-in for the FastAPI booking routes, with version checks. */
export function fakeApi(initial: Booking = heldBooking()) {
  let booking = initial;
  const bump = (patch: Partial<Booking>) => (booking = { ...booking, ...patch, version: booking.version + 1 });
  const expect = (version: number) => {
    if (version !== booking.version) throw new ApiError(409, "stale version");
  };
  const api = {
    getBooking: vi.fn(async (_id: string, _token?: string) => booking),
    markProcessing: vi.fn(async (_id: string, version: number) => {
      expect(version);
      if (booking.state !== "PENDING_PAYMENT") throw new ApiError(409, "not pending");
      return bump({ state: "PROCESSING", payment_status: "PROCESSING" });
    }),
    markFailed: vi.fn(async (_id: string, version: number) => {
      expect(version);
      return bump({ state: "PENDING_PAYMENT", payment_status: "FAILED" });
    }),
    finalize: vi.fn(async (_id: string, _key: string, tx: string, version: number) => {
      expect(version);
      return bump({ state: "CONFIRMED", payment_status: "SETTLED", transaction_hash: tx, confirmed_at: "2026-10-24T18:01:00Z" });
    }),
  } satisfies BookingApi;
  return { api, current: () => booking, set: (b: Booking) => (booking = b) };
}

export function fakeGateway(evidence: Partial<SettlementEvidence> = {}) {
  const gateway = {
    pay: vi.fn(
      async (_url: string, _key: string, onSigned?: () => void): Promise<SettlementEvidence> => {
        onSigned?.();
        return {
          transactionHash: TX,
          network: "eip155:84532",
          payer: "0xdriver",
          settledAt: "2026-10-24T18:00:30Z",
          ...evidence,
        };
      },
    ),
  } satisfies PaymentGateway;
  return gateway;
}

export function fakeWallet() {
  return {
    info: vi.fn(async () => ({
      network: "base-sepolia" as const,
      payer: { name: "curb-demo-driver", address: "0xdriver", usdc_balance: "9.25", explorer_url: "https://sepolia.basescan.org/address/0xdriver" },
      payee: { name: "curb-demo-owner", address: "0xowner" },
    })),
    topUp: vi.fn(async () => ({ transaction_hash: "0xfaucet", explorer_url: "https://sepolia.basescan.org/tx/0xfaucet" })),
  } satisfies WalletApi;
}
