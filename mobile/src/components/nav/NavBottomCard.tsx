import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow, status } from "@/config/tokens";

type Props = {
  etaMinutes: number;
  distanceLabel: string;
  arrivalTime: string;
  spotStatusText: string; // "Your spot is still open, seen 20 sec ago."
  driving: boolean;
  arrived: boolean;
  bottomInset: number;
  onToggleDrive: () => void;
  onEnd: () => void;
};

export function NavBottomCard({
  etaMinutes,
  distanceLabel,
  arrivalTime,
  spotStatusText,
  driving,
  arrived,
  bottomInset,
  onToggleDrive,
  onEnd,
}: Props) {
  return (
    <View style={[styles.card, { paddingBottom: bottomInset + 14 }]}>
      <View style={styles.etaRow}>
        <View>
          <Text style={styles.eta} accessibilityLabel={`${etaMinutes} minutes, ${distanceLabel}, arriving ${arrivalTime}`}>
            {arrived ? "Arrived" : `${etaMinutes} min`}
          </Text>
          <Text style={styles.meta}>
            {distanceLabel} · {arrivalTime}
          </Text>
        </View>
        <Pressable
          onPress={onEnd}
          accessibilityRole="button"
          accessibilityLabel="End navigation"
          style={({ pressed }) => [styles.end, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.endText}>End</Text>
        </Pressable>
      </View>

      <View style={styles.statusRow} accessibilityLiveRegion="polite">
        <View style={styles.statusDot} />
        <Text style={styles.status}>
          {spotStatusText} If it&apos;s taken, we&apos;ll reroute you.
        </Text>
      </View>

      <Pressable
        onPress={onToggleDrive}
        accessibilityRole="button"
        accessibilityLabel={driving ? "Pause demo drive" : "Simulate drive"}
        style={({ pressed }) => [styles.demo, pressed && { opacity: 0.85 }]}
      >
        <SymbolView name={driving ? "pause.fill" : "play.fill"} size={12} tintColor={ink.black} fallback={null} />
        <Text style={styles.demoText}>{arrived ? "Drive again" : driving ? "Pause demo" : "Simulate drive"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ink.white,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: 20,
    paddingTop: 18,
    ...shadow.floating,
  },
  etaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eta: { fontFamily: font.extrabold, fontSize: 28, color: ink.black, marginTop: 4 },
  meta: { fontFamily: font.regular, fontSize: 14, color: ink.grey500 },
  end: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: radius.button,
    backgroundColor: ink.grey100,
    alignItems: "center",
    justifyContent: "center",
  },
  endText: { fontFamily: font.bold, fontSize: 16, color: ink.black, marginTop: 2 },
  statusRow: { flexDirection: "row", gap: 10, marginTop: 14, alignItems: "flex-start" },
  statusDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: status.open, marginTop: 6 },
  status: { flex: 1, fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: ink.grey900 },
  demo: {
    marginTop: 14,
    height: 44,
    borderRadius: radius.control,
    backgroundColor: ink.grey100,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  demoText: { fontFamily: font.bold, fontSize: 14, color: ink.black, marginTop: 2 },
});
