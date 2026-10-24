import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, View } from "react-native";

import { ink } from "@/config/tokens";

import { roundButton } from "./MoodToggle";

type Props = { onPress?: () => void; label?: string };

/** Round account control; opens profile switching. */
export function AccountButton({ onPress, label = "Account" }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [roundButton.base, pressed && { backgroundColor: ink.grey100 }]}
    >
      <SymbolView name="person.fill" size={18} tintColor={ink.black} fallback={<View style={styles.fallback} />} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fallback: { width: 16, height: 16, borderRadius: 8, backgroundColor: ink.black },
});
