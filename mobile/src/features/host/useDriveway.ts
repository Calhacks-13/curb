// The seeded owner's single driveway listing (spec 7.7, owner side): edit
// availability, price and window with version checks; recover an abandoned
// hold; read the confirmed booking.

import { useCallback, useState } from "react";

import { getApi } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { Booking, Driveway } from "@/api/types";
import { hhmmToMinutes } from "@/lib/laTime";
import type { ParkingState } from "@/realtime/reducer";

export type DrivewayDraft = { available: boolean; price: number; start: string; end: string };

export const PRICE_RANGE = { min: 1, max: 50 } as const;

export function draftOf(d: Driveway): DrivewayDraft {
  return { available: d.state !== "UNAVAILABLE", price: Number(d.price_usdc), start: d.availability_start, end: d.availability_end };
}

export function sameDraft(a: DrivewayDraft, b: DrivewayDraft) {
  return a.available === b.available && a.price === b.price && a.start === b.start && a.end === b.end;
}

const toHhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Moves a same-day window edge by `deltaMin`, keeping at least an hour between start and end. */
export function shiftWindow(draft: DrivewayDraft, edge: "start" | "end", deltaMin: number): DrivewayDraft {
  const s = hhmmToMinutes(draft.start);
  const e = hhmmToMinutes(draft.end);
  if (edge === "start") {
    const next = Math.min(Math.max(0, s + deltaMin), e - 60);
    return { ...draft, start: toHhmm(next) };
  }
  const next = Math.max(Math.min(24 * 60 - 30, e + deltaMin), s + 60);
  return { ...draft, end: toHhmm(next) };
}

export function ownedDriveway(state: ParkingState, ownerId: string | null): Driveway | null {
  return Object.values(state.driveways).find((d) => d.owner_id === ownerId) ?? null;
}

export function confirmedBooking(state: ParkingState, drivewayId: string): Booking | null {
  return (
    Object.values(state.bookings)
      .filter((b) => b.driveway_id === drivewayId && b.state === "CONFIRMED")
      .sort((a, b) => (b.confirmed_at ?? "").localeCompare(a.confirmed_at ?? ""))[0] ?? null
  );
}

export function useDrivewayActions(onConflict: () => void) {
  const api = getApi();
  const [busy, setBusy] = useState<"save" | "recover" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const save = useCallback(
    async (d: Driveway, draft: DrivewayDraft) => {
      setBusy("save");
      setMessage(null);
      try {
        await api.updateDriveway(d.id, {
          expected_version: d.version,
          available: draft.available,
          price_usdc: draft.price.toFixed(2),
          availability_start: draft.start,
          availability_end: draft.end,
        });
        setMessage("Saved");
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.isConflict) {
          setMessage("This listing changed somewhere else. We refreshed it.");
          onConflict();
        } else {
          setMessage("Couldn't save. Try again.");
        }
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, onConflict],
  );

  const recover = useCallback(
    async (d: Driveway) => {
      setBusy("recover");
      setMessage(null);
      try {
        await api.recoverDriveway(d.id, d.version);
        setMessage("Listing is available again.");
      } catch (e) {
        setMessage(
          e instanceof ApiError && e.isConflict
            ? "A payment is processing right now, so the hold can't be released."
            : "Couldn't release the hold. Try again.",
        );
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  return { busy, message, save, recover, clearMessage: () => setMessage(null) };
}
