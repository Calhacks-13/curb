// Executes one held booking's payment exactly once (plan Task 9):
//   PENDING_PAYMENT -> mark PROCESSING -> pay over x402 -> finalize with tx hash.
// Settlement evidence is stored before finalizing, so a failed finalize becomes
// a reconciliation that retries only the finalize, never the payment. A failed
// payment goes back to the server as retryable, leaving the driveway held.

import { ApiError } from "./apiClient.js";
import type {
  Booking,
  BookingApi,
  PaymentGateway,
  PaymentPhase,
  PaymentProgress,
  PaymentResult,
  PaymentStore,
  SettlementEvidence,
} from "./types.js";

export class PaymentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly booking: Booking | null = null,
  ) {
    super(code);
  }
}

export type OrchestratorDeps = {
  api: BookingApi;
  gateway: PaymentGateway;
  store: PaymentStore;
  /** URL of this service's x402-protected receipt for a booking. */
  resourceUrl: (bookingId: string) => string;
  explorerUrl: (transactionHash: string) => string;
};

function failureCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") return err.code;
  return "PAYMENT_FAILED";
}

export function createOrchestrator({ api, gateway, store, resourceUrl, explorerUrl }: OrchestratorDeps) {
  const inFlight = new Map<string, Promise<PaymentResult>>();
  const progress = new Map<string, PaymentProgress>();

  function mark(bookingId: string, phase: PaymentPhase, extra: Partial<PaymentProgress> = {}) {
    const prev = progress.get(bookingId);
    const transaction_hash = extra.transaction_hash ?? prev?.transaction_hash ?? null;
    progress.set(bookingId, {
      booking_id: bookingId,
      phase,
      transaction_hash,
      explorer_url: transaction_hash ? explorerUrl(transaction_hash) : null,
      error_code: extra.error_code ?? null,
    });
  }

  const result = (booking: Booking): PaymentResult => ({
    booking,
    explorer_url: booking.transaction_hash ? explorerUrl(booking.transaction_hash) : null,
  });

  async function finalize(booking: Booking, evidence: SettlementEvidence): Promise<PaymentResult> {
    try {
      const confirmed = await api.finalize(booking.id, booking.idempotency_key, evidence.transactionHash, booking.version);
      store.put({ bookingId: booking.id, evidence, reconciliationRequired: false });
      mark(booking.id, "confirmed");
      return result(confirmed);
    } catch (err) {
      // A lost response can hide a finalize that did land; check before flagging.
      if (err instanceof ApiError && err.isConflict) {
        const latest = await api.getBooking(booking.id).catch(() => null);
        if (latest?.state === "CONFIRMED" && latest.transaction_hash === evidence.transactionHash) {
          store.put({ bookingId: booking.id, evidence, reconciliationRequired: false });
          mark(booking.id, "confirmed");
          return result(latest);
        }
      }
      store.put({ bookingId: booking.id, evidence, reconciliationRequired: true });
      mark(booking.id, "reconciliation_required");
      return {
        booking: { ...booking, state: "RECONCILIATION_REQUIRED", payment_status: "SETTLED", transaction_hash: evidence.transactionHash },
        explorer_url: explorerUrl(evidence.transactionHash),
      };
    }
  }

  async function run(bookingId: string, callerToken?: string): Promise<PaymentResult> {
    let booking = await api.getBooking(bookingId, callerToken);
    if (booking.state === "CONFIRMED") return result(booking);
    if (booking.state === "CANCELLED") throw new PaymentError(409, "BOOKING_CANCELLED", false, booking);

    const record = store.get(bookingId);
    if (record?.evidence) return finalize(booking, record.evidence);

    if (booking.state === "PENDING_PAYMENT") {
      try {
        booking = await api.markProcessing(bookingId, booking.version);
      } catch (err) {
        // The hold changed underneath us (owner recovery, cancel, stale version).
        if (err instanceof ApiError && err.isConflict) throw new PaymentError(409, "BOOKING_CHANGED", false, booking);
        throw err;
      }
    } else if (booking.state !== "PROCESSING") {
      throw new PaymentError(409, "RECONCILIATION_UNAVAILABLE", false, booking);
    }

    mark(bookingId, "approved");
    let evidence: SettlementEvidence;
    try {
      evidence = await gateway.pay(resourceUrl(bookingId), booking.idempotency_key, () => mark(bookingId, "signed"));
    } catch (err) {
      const code = failureCode(err);
      mark(bookingId, "failed", { error_code: code });
      const failed = await api.markFailed(bookingId, booking.version, code, true).catch(() => booking);
      throw new PaymentError(402, code, true, failed);
    }

    store.put({ bookingId, evidence, reconciliationRequired: true });
    mark(bookingId, "settled", { transaction_hash: evidence.transactionHash });
    return finalize(booking, evidence);
  }

  return {
    /** Pays for a held booking. Concurrent calls for one booking share one attempt. */
    executePayment(bookingId: string, callerToken?: string): Promise<PaymentResult> {
      const pending = inFlight.get(bookingId);
      if (pending) return pending;
      const attempt = run(bookingId, callerToken).finally(() => inFlight.delete(bookingId));
      inFlight.set(bookingId, attempt);
      return attempt;
    },
    /** Latest checkout step for a booking, or null before any attempt. */
    progress(bookingId: string): PaymentProgress | null {
      return progress.get(bookingId) ?? null;
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
