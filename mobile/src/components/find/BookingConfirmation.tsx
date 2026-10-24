import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { Booking, Driveway } from "@/api/types";
import { font, ink, radius, status } from "@/config/tokens";
import { formatHhmm } from "@/lib/laTime";

export function explorerUrl(hash: string) {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

export function shortHash(hash: string) {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

type Props = {
  driveway: Driveway;
  booking: Booking;
  routing: boolean;
  onRoute: () => void;
  onDone: () => void;
};

/** Booked: the receipt, the testnet transaction, and a route to the driveway. */
export function BookingConfirmation({ driveway, booking, routing, onRoute, onDone }: Props) {
  const hash = booking.transaction_hash;
  return (
    <View>
      <View style={styles.header} accessibilityLiveRegion="polite">
        <View style={styles.check}>
          <SymbolView name="checkmark" size={16} weight="bold" tintColor={ink.white} fallback={<Text style={styles.checkText}>✓</Text>} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title} accessibilityRole="header">
            Driveway reserved
          </Text>
          <Text style={styles.subtitle}>Held for you until {formatHhmm(driveway.availability_end)}.</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Paid</Text>
          <Text style={styles.value}>{Number(booking.amount_usdc).toFixed(2)} USDC</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Network</Text>
          <Text style={styles.value}>Base Sepolia (testnet)</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Transaction</Text>
          {hash ? (
            <Pressable onPress={() => WebBrowser.openBrowserAsync(explorerUrl(hash))} accessibilityRole="link" hitSlop={8}>
              <Text style={styles.link}>{shortHash(hash)}</Text>
            </Pressable>
          ) : (
            <Text style={styles.value}>None (demo replay)</Text>
          )}
        </View>
      </View>

      <Pressable onPress={onRoute} disabled={routing} accessibilityRole="button" style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}>
        <Text style={styles.ctaText}>{routing ? "Getting route" : "Route here"}</Text>
      </Pressable>
      <Pressable onPress={onDone} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}>
        <Text style={styles.secondaryText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 4, marginTop: 4 },
  check: { width: 34, height: 34, borderRadius: 17, backgroundColor: status.driveway, alignItems: "center", justifyContent: "center" },
  checkText: { color: ink.white, fontFamily: font.bold },
  headerText: { flex: 1 },
  title: { fontFamily: font.bold, fontSize: 20, color: ink.black, marginTop: 3 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  card: { marginTop: 12, padding: 12, borderRadius: radius.button, backgroundColor: ink.grey100, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  label: { fontFamily: font.regular, fontSize: 14, color: ink.grey500 },
  value: { fontFamily: font.semibold, fontSize: 14, color: ink.black },
  link: { fontFamily: font.bold, fontSize: 14, color: ink.black, textDecorationLine: "underline" },
  cta: { marginTop: 12, height: 52, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
  secondary: { marginTop: 8, height: 44, borderRadius: radius.control, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
});
