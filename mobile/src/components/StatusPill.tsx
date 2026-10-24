import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";

/** Small floating status, e.g. while realtime reconnects. The map keeps the last honest state. */
export function StatusPill({ text }: { text: string }) {
  return (
    <View style={styles.pill} accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={text}>
      <ActivityIndicator size="small" color={ink.black} />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: ink.white,
    alignSelf: "flex-start",
    ...shadow.floating,
  },
  text: { fontFamily: font.semibold, fontSize: 12, color: ink.black, marginTop: 2 },
});
