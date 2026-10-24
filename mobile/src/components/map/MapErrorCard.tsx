import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";

type Props = { message: string; onRetry: () => void };

/** Designed failure for the map itself; never shows raw errors to drivers. */
export function MapErrorCard({ message, onRetry }: Props) {
  const missingToken = /token/i.test(message);
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text style={styles.title}>{missingToken ? "Map isn't set up" : "Map didn't load"}</Text>
      <Text style={styles.body}>
        {missingToken ? "Add EXPO_PUBLIC_MAPBOX_TOKEN to mobile/.env and reload." : "Check your connection. Your parking list still works."}
      </Text>
      {!missingToken && (
        <Pressable onPress={onRetry} accessibilityRole="button" style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: radius.button, backgroundColor: ink.white, gap: 4, ...shadow.floating },
  title: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  body: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  button: { marginTop: 8, height: 38, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  buttonText: { fontFamily: font.bold, fontSize: 14, color: ink.white, marginTop: 2 },
});
