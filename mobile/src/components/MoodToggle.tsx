import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, StyleSheet, Text } from "react-native";

import { font, ink, shadow } from "@/config/tokens";
import type { MoodSetting } from "@/map/moods";

const NEXT: Record<MoodSetting, MoodSetting> = { auto: "clay", clay: "glow", glow: "auto" };

const LOOK: Record<MoodSetting, { icon: SymbolViewProps["name"]; label: string; fallback: string }> = {
  auto: { icon: "circle.lefthalf.filled", label: "Map: automatic by time of day", fallback: "A" },
  clay: { icon: "sun.max.fill", label: "Map: day", fallback: "D" },
  glow: { icon: "moon.fill", label: "Map: night", fallback: "N" },
};

type Props = {
  value: MoodSetting;
  onChange: (value: MoodSetting) => void;
};

/** Round map button that cycles automatic -> day -> night. */
export function MoodToggle({ value, onChange }: Props) {
  const look = LOOK[value];
  return (
    <Pressable
      onPress={() => onChange(NEXT[value])}
      accessibilityRole="button"
      accessibilityLabel={look.label}
      accessibilityHint="Changes the map style"
      hitSlop={6}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <SymbolView name={look.icon} size={18} tintColor={ink.black} fallback={<Text style={styles.fallback}>{look.fallback}</Text>} />
    </Pressable>
  );
}

export const roundButton = StyleSheet.create({
  base: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: ink.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.floating,
  },
});

const styles = StyleSheet.create({
  button: roundButton.base,
  pressed: { backgroundColor: ink.grey100 },
  fallback: { fontFamily: font.bold, fontSize: 14, color: ink.black },
});
