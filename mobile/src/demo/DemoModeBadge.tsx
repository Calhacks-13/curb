import { StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";

/**
 * Required whenever fixture or replay data is on screen (spec section 16): old or
 * scripted observations must never pass as live.
 */
export function DemoModeBadge() {
  return (
    <View
      style={styles.badge}
      accessible
      accessibilityRole="text"
      accessibilityLabel="Demo replay. Data shown is a fixture, not a live observation."
    >
      <View style={styles.dot} />
      <Text style={styles.text}>Demo replay</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: ink.black,
    alignSelf: "flex-start",
    ...shadow.floating,
  },
  dot: { width: 6, height: 6, borderRadius: 1, backgroundColor: ink.white },
  text: { fontFamily: font.bold, fontSize: 12, color: ink.white, marginTop: 2 },
});
