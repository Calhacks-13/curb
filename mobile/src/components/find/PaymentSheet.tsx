import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { Booking, Driveway } from "@/api/types";
import { font, ink, radius } from "@/config/tokens";
import type { CheckoutPhase } from "@/features/find/useDrivewayBooking";
import { formatHhmm } from "@/lib/laTime";

type Props = {
  driveway: Driveway;
  booking: Booking;
  phase: Extract<CheckoutPhase, "review" | "processing" | "failed">;
  error: string | null;
  demo: boolean;
  onPay: () => void;
  onCancel: () => void;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

/** Review and pay through Curb's pre-funded testnet demo wallet. */
export function PaymentSheet({ driveway, booking, phase, error, demo, onPay, onCancel }: Props) {
  const processing = phase === "processing";
  const amount = `${Number(booking.amount_usdc).toFixed(2)} USDC`;
  return (
    <View>
      <Text style={styles.title} accessibilityRole="header">
        {phase === "failed" ? "Payment didn't go through" : "Confirm reservation"}
      </Text>
      <Text style={styles.subtitle}>The driveway is on hold for you while you pay.</Text>

      <View style={styles.card}>
        <Row label="Driveway" value={`Today, ${formatHhmm(driveway.availability_start)} to ${formatHhmm(driveway.availability_end)}`} />
        <Row label="Amount" value={amount} />
        <Row label="Network" value="Base Sepolia (testnet)" />
        <Row label="Pay from" value="Curb demo wallet" />
      </View>
      <Text style={styles.note}>
        {demo
          ? "Demo replay: no money moves and no transaction is created."
          : "The demo wallet is pre-funded with testnet USDC. Payment uses x402 on Base Sepolia."}
      </Text>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      <Pressable
        onPress={onPay}
        disabled={processing}
        accessibilityRole="button"
        accessibilityState={{ busy: processing }}
        style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
      >
        {processing ? (
          <View style={styles.processing}>
            <ActivityIndicator color={ink.white} />
            <Text style={styles.ctaText}>Settling payment</Text>
          </View>
        ) : (
          <Text style={styles.ctaText}>{phase === "failed" ? "Retry payment" : `Pay ${amount}`}</Text>
        )}
      </Pressable>
      <Pressable
        onPress={onCancel}
        disabled={processing}
        accessibilityRole="button"
        accessibilityState={{ disabled: processing }}
        style={({ pressed }) => [styles.secondary, processing && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}
      >
        <Text style={styles.secondaryText}>Cancel hold</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: font.bold, fontSize: 20, color: ink.black, marginHorizontal: 4, marginTop: 4 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: ink.grey500, marginHorizontal: 4, marginTop: 2 },
  card: { marginTop: 12, padding: 12, borderRadius: radius.button, backgroundColor: ink.grey100, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { fontFamily: font.regular, fontSize: 14, color: ink.grey500 },
  rowValue: { flexShrink: 1, fontFamily: font.semibold, fontSize: 14, color: ink.black, textAlign: "right" },
  note: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, marginTop: 8, marginHorizontal: 4 },
  error: { fontFamily: font.semibold, fontSize: 13, color: ink.black, marginTop: 8, marginHorizontal: 4 },
  cta: { marginTop: 12, height: 52, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  processing: { flexDirection: "row", alignItems: "center", gap: 10 },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
  secondary: { marginTop: 8, height: 44, borderRadius: radius.control, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
});
