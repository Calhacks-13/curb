// The wallet a checkout pays from, and the live steps of a payment in flight.
// Both read the payment service (or the demo adapter); neither blocks checkout.

import { useCallback, useEffect, useState } from "react";

import { getApi } from "@/api/client";
import type { PaymentPhase, WalletInfo } from "@/api/types";

const POLL_MS = 600;

export type TopUp = "idle" | "requesting" | "requested" | "limited";

export function useCheckoutWallet(active: boolean) {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [topUp, setTopUp] = useState<TopUp>("idle");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getApi()
      .wallet()
      .then((w) => {
        if (cancelled) return;
        setWallet(w);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [active, attempt]);

  const refresh = useCallback(() => setAttempt((a) => a + 1), []);

  const requestTopUp = useCallback(async () => {
    setTopUp("requesting");
    try {
      await getApi().topUpWallet();
      setTopUp("requested");
      // Faucet transfers land within seconds; re-read the balance shortly after.
      setTimeout(refresh, 4000);
    } catch {
      setTopUp("limited");
    }
  }, [refresh]);

  return { wallet, failed, topUp, requestTopUp, refresh };
}

/** Polls the payment service for the current step while `active`. */
export function usePaymentPhase(bookingId: string | null, active: boolean): PaymentPhase | null {
  const [phase, setPhase] = useState<{ id: string; phase: PaymentPhase | null } | null>(null);

  useEffect(() => {
    if (!bookingId || !active) return;
    let cancelled = false;
    const poll = () =>
      getApi()
        .paymentProgress(bookingId)
        .then((p) => !cancelled && setPhase({ id: bookingId, phase: p.phase }))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bookingId, active]);

  return active && phase?.id === bookingId ? phase.phase : null;
}
