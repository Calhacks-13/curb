import { SymbolView } from "expo-symbols";
import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, shadow } from "@/config/tokens";

type Props = {
  spotsShared: number;
  reduceMotion: boolean;
  /** Stub: will open the dashcam sharing screen owned by the CV team. */
  onPress?: () => void;
};

export function SharingLivePip({ spotsShared, reduceMotion, onPress }: Props) {
  const blink = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      blink.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink, reduceMotion]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Sharing live. ${spotsShared} spots shared`}
      accessibilityHint="Opens camera sharing"
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.preview}>
        <SymbolView name="video.fill" size={14} tintColor={ink.grey500} fallback={null} />
        <View style={styles.liveTag}>
          <Animated.View style={[styles.dot, { opacity: blink }]} />
          <Text style={styles.liveText}>Live</Text>
        </View>
      </View>
      <Text style={styles.caption}>{spotsShared} spots shared</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 92,
    padding: 5,
    borderRadius: 12,
    backgroundColor: ink.black,
    ...shadow.floating,
  },
  preview: {
    height: 46,
    borderRadius: 8,
    backgroundColor: "#2C2C2E",
    alignItems: "center",
    justifyContent: "center",
  },
  liveTag: {
    position: "absolute",
    top: 6,
    left: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: ink.live },
  liveText: { fontFamily: font.bold, fontSize: 10, color: ink.white, marginTop: 2 },
  caption: { fontFamily: font.semibold, fontSize: 11, color: ink.white, marginTop: 5, marginBottom: 1, marginLeft: 2 },
});
