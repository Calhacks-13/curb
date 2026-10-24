import * as Location from "expo-location";
import { useEffect, useState } from "react";

import type { LngLat } from "@/api/types";

export type DriverLocation = {
  status: "off" | "pending" | "granted" | "denied";
  position: LngLat | null;
  heading: number | null;
  accuracyM: number | null;
  /** iOS lets you ask again only until the user says "Don't Allow". */
  canAskAgain: boolean;
  request: () => Promise<void>;
};

/** Foreground, precise location and heading while `enabled`. Never background. */
export function useDriverLocation(enabled: boolean): DriverLocation {
  const [permission, requestPermission] = Location.useForegroundPermissions();
  const [position, setPosition] = useState<LngLat | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [accuracyM, setAccuracy] = useState<number | null>(null);

  useEffect(() => {
    if (enabled && permission && !permission.granted && permission.canAskAgain && permission.status === "undetermined") {
      requestPermission();
    }
  }, [enabled, permission, requestPermission]);

  const granted = !!permission?.granted;
  useEffect(() => {
    if (!enabled || !granted) return;
    let pos: Location.LocationSubscription | null = null;
    let head: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      pos = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2, timeInterval: 1000 },
        (l) => {
          setPosition([l.coords.longitude, l.coords.latitude]);
          setAccuracy(l.coords.accuracy ?? null);
          // GPS course is the better heading while moving.
          if (l.coords.heading != null && l.coords.heading >= 0 && (l.coords.speed ?? 0) > 1) setHeading(l.coords.heading);
        },
      );
      head = await Location.watchHeadingAsync((h) => {
        if (h.trueHeading >= 0) setHeading((cur) => cur ?? h.trueHeading);
      });
      if (cancelled) {
        pos?.remove();
        head?.remove();
      }
    })();
    return () => {
      cancelled = true;
      pos?.remove();
      head?.remove();
    };
  }, [enabled, granted]);

  const status: DriverLocation["status"] = !enabled ? "off" : !permission ? "pending" : granted ? "granted" : permission.status === "undetermined" ? "pending" : "denied";
  return {
    status,
    position,
    heading,
    accuracyM,
    canAskAgain: permission?.canAskAgain ?? true,
    request: async () => {
      await requestPermission();
    },
  };
}
