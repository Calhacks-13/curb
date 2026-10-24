import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow, status } from "@/config/tokens";

import { roundButton } from "./MoodToggle";

type Glyph = "open" | "likely" | "driveway" | "red" | "white";

const ROWS: { glyph: Glyph; label: string }[] = [
  { glyph: "open", label: "Open spot" },
  { glyph: "likely", label: "Likely open" },
  { glyph: "driveway", label: "Driveway for rent" },
  { glyph: "red", label: "No parking" },
  { glyph: "white", label: "Loading zone" },
];

/** Miniature of how each thing is drawn on the map. */
function Glyph({ glyph }: { glyph: Glyph }) {
  if (glyph === "red" || glyph === "white") {
    const look =
      glyph === "red"
        ? { backgroundColor: status.noParking }
        : { backgroundColor: status.loading, borderWidth: 1, borderColor: status.loadingOutline };
    return (
      <View style={styles.glyphBox}>
        <View style={[styles.curb, look]} />
      </View>
    );
  }
  const look = {
    open: { backgroundColor: status.open, borderColor: status.open },
    likely: { backgroundColor: "rgba(31,143,78,0.14)", borderColor: status.open },
    driveway: { backgroundColor: status.driveway, borderColor: status.driveway },
  }[glyph];
  return (
    <View style={styles.glyphBox}>
      <View style={[styles.bay, look]} />
    </View>
  );
}

/** Round "i" button that opens what the map's colors mean. */
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
          {ROWS.map((r) => (
            <View key={r.label} style={styles.row}>
              <Glyph glyph={r.glyph} />
              <Text style={styles.label}>{r.label}</Text>
            </View>
          ))}
          <Text style={styles.note}>Lighter green means an older sighting.</Text>
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
    width: 200,
    padding: 14,
    gap: 10,
    borderRadius: radius.button,
    backgroundColor: ink.white,
    ...shadow.floating,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  glyphBox: { width: 26, height: 14, justifyContent: "center", alignItems: "center" },
  bay: { width: 24, height: 12, borderRadius: 2, borderWidth: 1.5 },
  curb: { width: 24, height: 3, borderRadius: 1 },
  label: { fontFamily: font.semibold, fontSize: 14, color: ink.black, marginTop: 2 },
  note: { fontFamily: font.regular, fontSize: 12, color: ink.grey500 },
  fallback: { fontFamily: font.bold, fontSize: 14, color: ink.black },
});
