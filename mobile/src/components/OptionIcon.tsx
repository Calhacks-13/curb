import { SymbolView } from "expo-symbols";
import { StyleSheet, Text, View } from "react-native";

import { font, ink, status } from "@/config/tokens";
import type { StallKind } from "@/map/curbLayers";

type ChipProps = { kind: StallKind; size?: number; mine?: boolean };

/**
 * Native twin of the map callout chips. Curb states share a parking-sign "P",
 * told apart by fill treatment, color and label; driveways get a house, with a
 * check badge once it's yours.
 */
export function OptionChip({ kind, size = 18, mine = false }: ChipProps) {
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.28) };

  if (kind === "driveway") {
    const badge = Math.round(size * 0.62);
    return (
      <View style={[box, styles.center, { backgroundColor: status.driveway }]}>
        <SymbolView name="house.fill" size={size * 0.6} tintColor={ink.white} fallback={<Text style={[styles.p, { fontSize: size * 0.6 }]}>H</Text>} />
        {mine && (
          <View style={[styles.badge, { width: badge, height: badge, borderRadius: badge / 2, right: -badge / 3, bottom: -badge / 3 }]}>
            <SymbolView name="checkmark" size={badge * 0.6} weight="heavy" tintColor={status.driveway} fallback={null} />
          </View>
        )}
      </View>
    );
  }

  const look =
    kind === "fresh"
      ? { backgroundColor: status.fresh, color: ink.white }
      : kind === "aging"
        ? { borderWidth: 2, borderColor: status.aging, color: status.aging }
        : { borderWidth: 1.5, borderColor: status.stale, borderStyle: "dashed" as const, color: status.stale };
  const { color, ...frame } = look;
  return (
    <View style={[box, styles.center, frame]}>
      <Text style={[styles.p, { color, fontSize: size * 0.66 }]}>P</Text>
    </View>
  );
}

/** Row icon: a light tile holding the chip. */
export function OptionIcon({ kind, mine }: { kind: StallKind; mine?: boolean }) {
  return (
    <View style={styles.tile}>
      <OptionChip kind={kind} size={22} mine={mine} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 40, height: 40, borderRadius: 10, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center", justifyContent: "center" },
  p: { fontFamily: font.extrabold, color: ink.white, marginTop: 2 },
  badge: {
    position: "absolute",
    backgroundColor: ink.white,
    borderWidth: 1.5,
    borderColor: status.driveway,
    alignItems: "center",
    justifyContent: "center",
  },
});
