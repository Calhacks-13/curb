import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { Driveway } from "@/api/types";
import { font, ink, radius } from "@/config/tokens";
import { formatDistance, formatUsdc, walkMinutes } from "@/features/find/options";
import { formatHhmm } from "@/lib/laTime";

import { OptionChip } from "../OptionIcon";

type Props = {
  driveway: Driveway;
  distanceM: number;
  holding: boolean;
  error: string | null;
  onReserve: () => void;
  onClose: () => void;
};

export function DrivewayPhoto({ uri }: { uri: string | null }) {
  if (!uri) {
    return (
      <View style={[styles.photo, styles.photoEmpty]}>
        <SymbolView name="car.fill" size={22} tintColor={ink.grey500} fallback={null} />
      </View>
    );
  }
  return <Image source={{ uri }} style={styles.photo} contentFit="cover" transition={200} accessibilityLabel="Aerial photo of the driveway" />;
}

/** Price, photo, distance and window first; Reserve only places a hold. */
export function DrivewayDetailSheet({ driveway, distanceM, holding, error, onReserve, onClose }: Props) {
  const available = driveway.state === "AVAILABLE";
  return (
    <View>
      <View style={styles.header}>
        <OptionChip kind="driveway" size={20} />
        <Text style={styles.title} accessibilityRole="header">
          Private driveway
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close details" hitSlop={10} style={styles.close}>
          <SymbolView name="xmark" size={13} weight="bold" tintColor={ink.black} fallback={<Text style={styles.closeText}>x</Text>} />
        </Pressable>
      </View>

      <DrivewayPhoto uri={driveway.photo_url} />

      <View style={styles.facts}>
        <View style={styles.fact}>
          <Text style={styles.factValue}>{formatUsdc(driveway.price_usdc)}</Text>
          <Text style={styles.factLabel}>USDC</Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factValue}>
            {formatHhmm(driveway.availability_start)} to {formatHhmm(driveway.availability_end)}
          </Text>
          <Text style={styles.factLabel}>Available today</Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factValue}>{formatDistance(distanceM)}</Text>
          <Text style={styles.factLabel}>{walkMinutes(distanceM)} min walk</Text>
        </View>
      </View>

      <Text style={styles.guarantee}>Guaranteed once payment confirms. Unlike curb spots, nobody else can take it.</Text>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      <Pressable
        onPress={onReserve}
        disabled={!available || holding}
        accessibilityRole="button"
        accessibilityState={{ disabled: !available, busy: holding }}
        style={({ pressed }) => [styles.cta, !available && styles.ctaDisabled, pressed && { opacity: 0.85 }]}
      >
        {holding ? (
          <ActivityIndicator color={ink.white} />
        ) : (
          <Text style={styles.ctaText}>{available ? `Reserve for ${formatUsdc(driveway.price_usdc)}` : "On hold for another driver"}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 4, marginTop: 2, marginBottom: 10 },
  title: { flex: 1, fontFamily: font.bold, fontSize: 20, color: ink.black, marginTop: 3 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  closeText: { fontFamily: font.bold, fontSize: 13, color: ink.black },
  photo: { height: 132, borderRadius: radius.button, backgroundColor: ink.grey100 },
  photoEmpty: { alignItems: "center", justifyContent: "center" },
  facts: { flexDirection: "row", marginTop: 12, marginHorizontal: 4, gap: 12 },
  fact: { flex: 1 },
  factValue: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  factLabel: { fontFamily: font.regular, fontSize: 12, color: ink.grey500 },
  guarantee: { fontFamily: font.regular, fontSize: 13, color: ink.grey700, marginTop: 10, marginHorizontal: 4 },
  error: { fontFamily: font.semibold, fontSize: 13, color: ink.black, marginTop: 8, marginHorizontal: 4 },
  cta: { marginTop: 12, height: 52, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  ctaDisabled: { backgroundColor: ink.grey300 },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
});
