// Loads a booking the app didn't see confirmed this session (e.g. after a
// reload), so the driver's reservation can still show its receipt.

import { useEffect, useState } from "react";

import { getApi } from "@/api/client";
import type { Booking } from "@/api/types";

export function useBooking(bookingId: string | null, known: Booking | undefined): Booking | null {
  const [fetched, setFetched] = useState<Booking | null>(null);

  useEffect(() => {
    if (!bookingId || known) return;
    let cancelled = false;
    getApi()
      .booking(bookingId)
      .then((b) => !cancelled && setFetched(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookingId, known]);

  if (known) return known;
  return fetched?.id === bookingId ? fetched : null;
}
