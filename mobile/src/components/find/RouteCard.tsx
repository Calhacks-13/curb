import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, SEP } from "@/config/tokens";
import { formatDistance, type FindOption } from "@/features/find/options";
import { confidenceDrop, formatDuration, REPLACEMENT_CONFIDENCE_PERCENT, type Route } from "@/features/find/route";

import { OptionChip } from "../OptionIcon";

type Props = {
  route: Route;
  /** The routed option as it is right now; null once it's gone. */
  target: FindOption | null;
  /** The displayed percentage when the driver tapped Route here; null for driveways. */
  initialConfidencePercent: number | null;
  /** The target's latest observation timestamp, so a refresh can be announced once. */
  observedAt: string | null;
  onEnd: () => void;
};

type Phase = "gone" | "driveway" | "low" | "falling" | "steady";

const PHASE_STATUS: Record<Exclude<Phase, "driveway">, string> = {
  gone: "This spot is no longer showing as open.",
  low: `Below ${REPLACEMENT_CONFIDENCE_PERCENT}% open. We'll suggest another nearby spot.`,
  falling: `Confidence is falling. We'll suggest another nearby spot if it drops below ${REPLACEMENT_CONFIDENCE_PERCENT}%.`,
  steady: "Still showing open.",
};

/**
 * Tracks the coarse routing phase and whether the latest change was a fresh
 * observation, so the polite live region speaks on events rather than every tick.
 */
function useAnnouncement(phase: Phase, observedAt: string | null): { refreshed: boolean } {
  const [seen, setSeen] = useState({ phase, observedAt, refreshed: false });
  if (seen.phase !== phase || seen.observedAt !== observedAt) {
    const refreshed = seen.observedAt !== observedAt && seen.observedAt != null && observedAt != null;
    setSeen({ phase, observedAt, refreshed });
  }
  return { refreshed: seen.refreshed };
}

/** Shown while a route is drawn. No turn-by-turn: just where you're heading and whether it's still there. */
export function RouteCard({ route, target, initialConfidencePercent, observedAt, onEnd }: Props) {
  const curb = target != null && target.kind !== "driveway";
  const percent = curb ? (target.confidencePercent ?? null) : null;
  const drop = confidenceDrop(initialConfidencePercent, percent);
  const phase: Phase = !target
    ? "gone"
    : !curb
      ? "driveway"
      : (percent ?? 0) < REPLACEMENT_CONFIDENCE_PERCENT
        ? "low"
        : drop >= 1
          ? "falling"
          : "steady";
  const { refreshed } = useAnnouncement(phase, observedAt);

  const status =
    phase === "driveway"
      ? target?.title === "Your driveway"
        ? "Reserved for you. Nobody else can take it."
        : "Guaranteed once your booking is confirmed."
      : refreshed && phase !== "gone"
        ? "Seen again just now. Confidence updated."
        : PHASE_STATUS[phase];

  return (
    <View>
      <View style={styles.header}>
        {target && <OptionChip kind={target.kind} size={18} mine={target.mine} />}
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          Route in progress
        </Text>
      </View>
      <View style={styles.top}>
        <Text style={styles.eta}>
          {formatDuration(route.durationS)}
          {SEP}
          {formatDistance(route.distanceM)}
        </Text>
        {percent != null && (
          <Text style={styles.percent} accessibilityLabel={`Chance the spot is open: ${percent} percent`}>
            {percent}% open
          </Text>
        )}
      </View>
      {drop >= 1 && <Text style={styles.drop}>Confidence fell {drop}% while routing</Text>}
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {status}
      </Text>
      <Text style={styles.disclaimer}>Your route won&apos;t change unless you confirm.</Text>
      <Pressable onPress={onEnd} accessibilityRole="button" style={({ pressed }) => [styles.end, pressed && { opacity: 0.85 }]}>
        <Text style={styles.endText}>End route</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 4, marginTop: 2 },
  title: { flex: 1, fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 3 },
  top: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginHorizontal: 4, marginTop: 6 },
  eta: { flexShrink: 1, fontFamily: font.extrabold, fontSize: 28, color: ink.black },
  percent: { fontFamily: font.extrabold, fontSize: 17, color: ink.black },
  drop: { fontFamily: font.semibold, fontSize: 14, color: ink.black, marginHorizontal: 4, marginTop: 4 },
  status: { fontFamily: font.semibold, fontSize: 14, color: ink.black, marginHorizontal: 4, marginTop: 2 },
  disclaimer: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, marginHorizontal: 4, marginTop: 6 },
  end: {
    marginTop: 12,
    height: 48,
    borderRadius: radius.control,
    backgroundColor: ink.grey100,
    alignItems: "center",
    justifyContent: "center",
  },
  endText: { fontFamily: font.bold, fontSize: 16, color: ink.black, marginTop: 2 },
});
