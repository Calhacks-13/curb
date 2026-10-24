// Payment-service boundary (plan Task 9). The FastAPI server owns booking state;
// this service only moves money and reports the outcome back to it.

import type { BookingView } from "@curb/contracts/domain";

export type Booking = BookingView;

/** What a settled x402 payment proves, kept so a retry never pays twice. */
export type SettlementEvidence = {
  transactionHash: string;
  /** CAIP-2 id, e.g. "eip155:84532". */
  network: string;
  payer: string | null;
  settledAt: string;
};

export interface PaymentGateway {
  /**
   * Pays for an x402-protected resource and resolves once it has settled.
   * `onSigned` fires when the wallet has signed the payment authorization.
   */
  pay(resourceUrl: string, idempotencyKey: string, onSigned?: () => void): Promise<SettlementEvidence>;
}

/** Where a booking's payment is, for the app's live checkout steps. */
export type PaymentPhase = "approved" | "signed" | "settled" | "confirmed" | "failed" | "reconciliation_required";

export type PaymentProgress = {
  booking_id: string;
  phase: PaymentPhase;
  transaction_hash: string | null;
  explorer_url: string | null;
  error_code: string | null;
};

export type WalletInfo = {
  network: "base-sepolia";
  payer: { name: string; address: string; usdc_balance: string; explorer_url: string };
  payee: { name: string; address: string };
};

/** The demo wallets the service pays from and into. */
export interface WalletApi {
  info(): Promise<WalletInfo>;
  /** Requests testnet USDC for the payer; resolves with the faucet transaction. */
  topUp(): Promise<{ transaction_hash: string; explorer_url: string }>;
}

/** The booking routes on the FastAPI server (plan Task 8). */
export interface BookingApi {
  /** Read with the caller's own token so the server checks they own the booking. */
  getBooking(bookingId: string, callerToken?: string): Promise<Booking>;
  markProcessing(bookingId: string, expectedVersion: number): Promise<Booking>;
  markFailed(bookingId: string, expectedVersion: number, code: string, retryable: boolean): Promise<Booking>;
  finalize(bookingId: string, idempotencyKey: string, transactionHash: string, expectedVersion: number): Promise<Booking>;
}

export type PaymentRecord = {
  bookingId: string;
  evidence: SettlementEvidence | null;
  /** Settled on-chain but the server hasn't recorded it yet. */
  reconciliationRequired: boolean;
};

export interface PaymentStore {
  get(bookingId: string): PaymentRecord | undefined;
  put(record: PaymentRecord): void;
}

export type PaymentResult = {
  booking: Booking;
  explorer_url: string | null;
};

export class MemoryPaymentStore implements PaymentStore {
  private readonly records = new Map<string, PaymentRecord>();
  get(bookingId: string) {
    return this.records.get(bookingId);
  }
  put(record: PaymentRecord) {
    this.records.set(record.bookingId, record);
  }
}
