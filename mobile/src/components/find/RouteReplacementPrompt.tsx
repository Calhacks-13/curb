import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";
import type { Replacement } from "@/features/find/route";

import { OptionChip } from "../OptionIcon";

type Props = {
  replacement: Replacement;
  onAccept: () => void;
  onKeep: () => void;
};

/**
 * Offered when the routed spot is taken or its confidence falls below 50%.
 * Nothing changes until the driver taps "Route to new spot".
 */
export function RouteReplacementPrompt({ replacement, onAccept, onKeep }: Props) {
  const { reason, alternative } = replacement;
  const title = reason === "taken" ? "That spot was just taken" : "That spot is now under 50% likely to be open";
  return (
    <View style={styles.card} accessibilityViewIsModal accessibilityLiveRegion="assertive">
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {alternative ? (
        <>
          <View style={styles.alt}>
            <OptionChip kind={alternative.kind} size={18} />
            <View style={styles.altText}>
              <Text style={styles.altTitle}>{alternative.title}</Text>
              <Text style={styles.altDetail}>{alternative.detail}</Text>
            </View>
            <Text style={styles.altTrailing}>{alternative.trailing}</Text>
          </View>
          <View style={styles.buttons}>
            <Pressable onPress={onKeep} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}>
              <Text style={styles.secondaryText}>Keep route</Text>
            </Pressable>
            <Pressable onPress={onAccept} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}>
              <Text style={styles.primaryText}>Route to new spot</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.altDetail}>No other openings nearby right now. Blue curbs are still legal to park.</Text>
          <Pressable onPress={onKeep} accessibilityRole="button" style={({ pressed }) => [styles.secondary, styles.single, pressed && { opacity: 0.85 }]}>
            <Text style={styles.secondaryText}>OK</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: ink.white, borderRadius: radius.sheet, padding: 16, gap: 10, ...shadow.floating },
  title: { fontFamily: font.bold, fontSize: 17, color: ink.black, marginTop: 2 },
  alt: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: radius.button, backgroundColor: ink.grey100 },
  altText: { flex: 1 },
  altTitle: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  altDetail: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  altTrailing: { fontFamily: font.bold, fontSize: 14, color: ink.black },
  buttons: { flexDirection: "row", gap: 8 },
  secondary: { flex: 1, height: 46, borderRadius: radius.control, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  single: { flex: 0, alignSelf: "stretch" },
  secondaryText: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  primary: { flex: 1.4, height: 46, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  primaryText: { fontFamily: font.bold, fontSize: 15, color: ink.white, marginTop: 2 },
});
