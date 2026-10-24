// Driver checkout for a driveway (spec 7.7 / 7.8). Reserve places a hold, the
// payment sheet runs the x402 payment through the backend's demo wallet, and a
// failure keeps the hold so the driver can retry or cancel. Holds have no
// automatic timeout, so there's no countdown.

import { useCallback, useState } from "react";

import { getApi } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { Booking, Driveway } from "@/api/types";

export type CheckoutPhase = "detail" | "holding" | "review" | "processing" | "failed" | "confirmed";

export type Checkout = {
  phase: CheckoutPhase;
  booking: Booking | null;
  error: string | null;
};

const initial: Checkout = { phase: "detail", booking: null, error: null };

export function useDrivewayBooking(onConfirmed?: (booking: Booking) => void) {
  const api = getApi();
  const [checkout, setCheckout] = useState<Checkout>(initial);

  const reserve = useCallback(
    async (driveway: Driveway) => {
      setCheckout({ phase: "holding", booking: null, error: null });
      try {
        const booking = await api.holdDriveway(driveway.id, driveway.version);
        setCheckout({ phase: "review", booking, error: null });
      } catch (e) {
        const taken = e instanceof ApiError && e.isConflict;
        setCheckout({
          phase: "detail",
          booking: null,
          error: taken ? "Someone else just started reserving this driveway." : "Couldn't place a hold. Try again.",
        });
      }
    },
    [api],
  );

  const pay = useCallback(async () => {
    const booking = checkout.booking;
    if (!booking) return;
    setCheckout({ phase: "processing", booking, error: null });
    try {
      // Retries reuse the same booking intent; the service never charges twice.
      const confirmed = await api.executePayment(booking.id);
      if (confirmed.state === "CONFIRMED") {
        setCheckout({ phase: "confirmed", booking: confirmed, error: null });
        onConfirmed?.(confirmed);
      } else {
        setCheckout({ phase: "failed", booking: confirmed, error: "Payment didn't complete." });
      }
    } catch {
      setCheckout({ phase: "failed", booking, error: "Payment didn't go through. Your hold is still in place." });
    }
  }, [api, checkout.booking, onConfirmed]);

  const cancel = useCallback(
    async (driveway: Driveway) => {
      const booking = checkout.booking;
      if (booking) {
        try {
          await api.cancelHold(driveway.id, booking.id);
        } catch {
          setCheckout((c) => ({ ...c, error: "Couldn't cancel the hold right now. Try again." }));
          return;
        }
      }
      setCheckout(initial);
    },
    [api, checkout.booking],
  );

  const reset = useCallback(() => setCheckout(initial), []);

  return { checkout, reserve, pay, cancel, reset };
}
