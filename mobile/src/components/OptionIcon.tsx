import { SymbolView } from "expo-symbols";
import { StyleSheet, Text, View } from "react-native";

import { font, ink, status } from "@/config/tokens";
import type { StallKind } from "@/map/curbLayers";

/** Native twin of the map callout chips: same shape and color per meaning. */
export function OptionChip({ kind, size = 16 }: { kind: StallKind; size?: number }) {
  if (kind === "driveway") {
    return (
      <View style={[styles.square, { width: size + 4, height: size + 4 }]}>
        <SymbolView name="lock.fill" size={size * 0.62} tintColor={ink.white} fallback={<Text style={styles.lock}>$</Text>} />
      </View>
    );
  }
  const r = { width: size, height: size, borderRadius: size / 2 };
  if (kind === "fresh") return <View style={[r, { backgroundColor: status.fresh }]} />;
  if (kind === "aging") {
    return (
      <View style={[r, styles.ring, { borderColor: status.aging }]}>
        <View style={[styles.dot, { backgroundColor: status.aging }]} />
      </View>
    );
  }
  return <View style={[r, styles.ring, { borderColor: status.stale, borderStyle: "dashed", borderWidth: 2 }]} />;
}

/** Row icon: a light tile holding the chip. */
export function OptionIcon({ kind }: { kind: StallKind }) {
  return (
    <View style={styles.tile}>
      <OptionChip kind={kind} size={18} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 40, height: 40, borderRadius: 10, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  square: { borderRadius: 5, backgroundColor: status.driveway, alignItems: "center", justifyContent: "center" },
  ring: { borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  lock: { fontFamily: font.bold, fontSize: 11, color: ink.white },
});
