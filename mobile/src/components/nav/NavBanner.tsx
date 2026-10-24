import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";
import type { Maneuver } from "@/data/provider";

type Props = {
  maneuver: Maneuver;
  distanceLabel: string; // "400 ft"
  instruction: string; // "Turn left onto Chestnut St"
};

const ICONS: Record<Maneuver, SymbolViewProps["name"]> = {
  left: "arrow.turn.up.left",
  right: "arrow.turn.up.right",
  straight: "arrow.up",
  arrive: "mappin.and.ellipse",
};

export function NavBanner({ maneuver, distanceLabel, instruction }: Props) {
  return (
    <View style={styles.card} accessibilityRole="header" accessibilityLabel={`${distanceLabel}, ${instruction}`}>
      <SymbolView name={ICONS[maneuver]} size={34} tintColor={ink.white} weight="semibold" fallback={null} />
      <View style={styles.text}>
        <Text style={styles.distance}>{distanceLabel}</Text>
        <Text style={styles.instruction} numberOfLines={2}>
          {instruction}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    backgroundColor: ink.black,
    borderRadius: radius.sheet,
    paddingHorizontal: 20,
    paddingVertical: 16,
    ...shadow.floating,
  },
  text: { flex: 1 },
  distance: { fontFamily: font.extrabold, fontSize: 30, color: ink.white, marginTop: 4 },
  instruction: { fontFamily: font.semibold, fontSize: 18, color: ink.white, marginTop: 2 },
});
