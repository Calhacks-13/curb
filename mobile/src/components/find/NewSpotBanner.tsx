import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, SEP, shadow } from "@/config/tokens";
import type { SpotAlert } from "@/features/find/newSpots";
import { formatDistance, type FindOption } from "@/features/find/options";

import { OptionChip } from "../OptionIcon";

type Props = {
  alert: SpotAlert;
  /** Current options; the banner shows only openings that are still there. */
  options: FindOption[];
  routing: boolean;
  reduceMotion: boolean;
  onOpen: (option: FindOption) => void;
  onDismiss: () => void;
};

const VISIBLE_MS = 5000;

/** Slides in from the top when a new opening appears nearby; tap to open it. */
export function NewSpotBanner({ alert, options, routing, reduceMotion, onOpen, onDismiss }: Props) {
  const [slide] = useState(() => new Animated.Value(reduceMotion ? 0 : -120));
  const spots = alert.ids
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is FindOption => !!o)
    .sort((a, b) => a.distanceM - b.distanceM);

  useEffect(() => {
    if (reduceMotion) return;
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 180 }).start();
  }, [slide, reduceMotion, alert.at]);

  // Auto-hide a few seconds after the latest opening.
  useEffect(() => {
    const t = setTimeout(onDismiss, VISIBLE_MS);
    return () => clearTimeout(t);
  }, [alert.at, onDismiss]);

  const closest = spots[0];
  if (!closest) return null;

  const title = routing ? "A closer spot just opened" : spots.length > 1 ? `${spots.length} new spots nearby` : "New spot opened";
  const detail = spots.length > 1 && !routing ? `Closest is ${formatDistance(closest.distanceM)} away` : `${formatDistance(closest.distanceM)} away${SEP}just now`;

  return (
    <Animated.View style={[styles.wrap, { transform: [{ translateY: slide }] }]} accessibilityLiveRegion="polite">
      <Pressable
        onPress={() => {
          onDismiss();
          onOpen(closest);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${detail}. Opens details.`}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
      >
        <OptionChip kind={closest.kind} size={26} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <Text style={styles.action}>View</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, zIndex: 30 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.sheet,
    backgroundColor: ink.black,
    ...shadow.floating,
  },
  text: { flex: 1 },
  title: { fontFamily: font.bold, fontSize: 16, lineHeight: 21, color: ink.white, paddingTop: 2 },
  detail: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: ink.grey300 },
  action: { fontFamily: font.bold, fontSize: 14, color: ink.white, paddingTop: 2 },
});
