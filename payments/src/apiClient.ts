// HTTP client for the FastAPI booking routes. Service calls carry the payment
// service token; the ownership read carries the driver's own token.

import type { Booking, BookingApi } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`FastAPI ${status}: ${detail}`);
  }
  get isConflict() {
    return this.status === 409;
  }
}

export function createBookingApi(baseUrl: string, serviceToken: string, fetchImpl: typeof fetch = fetch): BookingApi {
  const root = baseUrl.replace(/\/+$/, "");

  async function call(method: string, path: string, body: unknown, token: string): Promise<Booking> {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        detail = JSON.parse(text).detail ?? text;
      } catch {
        // Non-JSON error body; keep the raw text.
      }
      throw new ApiError(res.status, String(detail));
    }
    return (await res.json()) as Booking;
  }

  const booking = (id: string) => `/v1/bookings/${encodeURIComponent(id)}`;

  return {
    getBooking: (id, callerToken) => call("GET", booking(id), undefined, callerToken ?? serviceToken),
    markProcessing: (id, expected) =>
      call("POST", `${booking(id)}/payment-processing`, { expected_booking_version: expected }, serviceToken),
    markFailed: (id, expected, code, retryable) =>
      call("POST", `${booking(id)}/payment-failed`, { expected_booking_version: expected, code, retryable }, serviceToken),
    finalize: (id, idempotencyKey, transactionHash, expected) =>
      call(
        "POST",
        `${booking(id)}/finalize`,
        { idempotency_key: idempotencyKey, transaction_hash: transactionHash, expected_booking_version: expected },
        serviceToken,
      ),
  };
}
