import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow, status } from "@/config/tokens";

import { roundButton } from "./roundButton";
import { OptionChip } from "./OptionIcon";

const ROWS = [
  { kind: "fresh", label: "Likely open", note: "seen in the last 90 sec" },
  { kind: "aging", label: "May still be open", note: "seen 1.5 to 3 min ago" },
  { kind: "stale", label: "Stale observation", note: "3 to 5 min old" },
  { kind: "driveway", label: "Driveway", note: "guaranteed after payment" },
] as const;

/** Round "i" button that opens what the map's colors and shapes mean. */
export function MapLegend() {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Map key"
        hitSlop={6}
        style={({ pressed }) => [roundButton.base, (pressed || open) && { backgroundColor: ink.grey100 }]}
      >
        <SymbolView
          name={open ? "xmark" : "info"}
          size={16}
          weight="semibold"
          tintColor={ink.black}
          fallback={<Text style={styles.fallback}>{open ? "x" : "i"}</Text>}
        />
      </Pressable>
      {open && (
        <View style={styles.card} accessibilityRole="summary">
          <View style={styles.row}>
            <View style={styles.glyph}>
              <View style={styles.curb} />
            </View>
            <View style={styles.text}>
              <Text style={styles.label}>Legal to park now</Text>
              <Text style={styles.note}>availability unknown</Text>
            </View>
          </View>
          {ROWS.map((r) => (
            <View key={r.kind} style={styles.row}>
              <View style={styles.glyph}>
                <OptionChip kind={r.kind} size={16} />
              </View>
              <View style={styles.text}>
                <Text style={styles.label}>{r.label}</Text>
                <Text style={styles.note}>{r.note}</Text>
              </View>
            </View>
          ))}
          <View style={styles.row}>
            <View style={styles.glyph}>
              <OptionChip kind="driveway" size={16} mine />
            </View>
            <View style={styles.text}>
              <Text style={styles.label}>Your driveway</Text>
              <Text style={styles.note}>on hold or booked for you</Text>
            </View>
          </View>
          <Text style={styles.footer}>Curb spots aren&apos;t reserved. Only driveways are guaranteed.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end" },
  card: {
    position: "absolute",
    top: 52,
    right: 0,
    width: 236,
    padding: 14,
    gap: 10,
    borderRadius: radius.button,
    backgroundColor: ink.white,
    ...shadow.floating,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  glyph: { width: 24, alignItems: "center" },
  curb: { width: 22, height: 4, borderRadius: 1, backgroundColor: status.legal },
  text: { flex: 1 },
  label: { fontFamily: font.semibold, fontSize: 14, color: ink.black, marginTop: 2 },
  note: { fontFamily: font.regular, fontSize: 12, color: ink.grey500 },
  footer: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, marginTop: 2 },
  fallback: { fontFamily: font.bold, fontSize: 14, color: ink.black },
});
