import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius } from "@/config/tokens";
import { formatAge } from "@/features/find/freshness";
import { formatDistance, type FindOption } from "@/features/find/options";
import { formatDuration, type Route } from "@/features/find/route";

import { OptionChip } from "../OptionIcon";

type Props = {
  route: Route;
  /** The routed option as it is right now; null once it's gone. */
  target: FindOption | null;
  targetTitle: string;
  ageSeconds: number | null;
  onEnd: () => void;
};

/** Shown while a route is drawn. No turn-by-turn: just where you're heading and whether it's still there. */
export function RouteCard({ route, target, targetTitle, ageSeconds, onEnd }: Props) {
  const status = !target
    ? "This spot is no longer showing as open."
    : target.kind === "driveway"
      ? "Guaranteed once your booking is confirmed."
      : `Still showing open, seen ${formatAge(ageSeconds ?? 0)}.`;

  return (
    <View>
      <View style={styles.header}>
        {target && <OptionChip kind={target.kind} size={16} />}
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          Route to {targetTitle.toLowerCase()}
        </Text>
      </View>
      <Text style={styles.eta}>
        {formatDuration(route.durationS)} · {formatDistance(route.distanceM)}
      </Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {status}
      </Text>
      <Text style={styles.disclaimer}>If it&apos;s taken we&apos;ll suggest another nearby spot. Your route won&apos;t change unless you confirm.</Text>
      <Pressable onPress={onEnd} accessibilityRole="button" style={({ pressed }) => [styles.end, pressed && { opacity: 0.85 }]}>
        <Text style={styles.endText}>End route</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 4, marginTop: 2 },
  title: { flex: 1, fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 3 },
  eta: { fontFamily: font.extrabold, fontSize: 28, color: ink.black, marginHorizontal: 4, marginTop: 6 },
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
