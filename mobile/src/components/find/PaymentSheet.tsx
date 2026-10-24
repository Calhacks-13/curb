import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { Booking, Driveway, PaymentPhase, WalletInfo } from "@/api/types";
import { font, ink, radius, SEP, status } from "@/config/tokens";
import type { TopUp } from "@/features/find/useCheckoutWallet";
import type { CheckoutPhase } from "@/features/find/useDrivewayBooking";
import { formatHhmm } from "@/lib/laTime";

import { shortHash } from "./BookingConfirmation";

type Props = {
  driveway: Driveway;
  booking: Booking;
  phase: Extract<CheckoutPhase, "review" | "processing" | "failed">;
  error: string | null;
  demo: boolean;
  wallet: WalletInfo | null;
  walletFailed: boolean;
  topUp: TopUp;
  /** Live step from the payment service while processing. */
  step: PaymentPhase | null;
  onTopUp: () => void;
  onPay: () => void;
  onCancel: () => void;
};

const STEPS: { phase: PaymentPhase; label: string }[] = [
  { phase: "approved", label: "Payment approved" },
  { phase: "signed", label: "Signed by your wallet" },
  { phase: "settled", label: "Settled on Base" },
  { phase: "confirmed", label: "Driveway booked" },
];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function WalletCard({ wallet, failed, demo, short, topUp, onTopUp }: {
  wallet: WalletInfo | null;
  failed: boolean;
  demo: boolean;
  short: boolean;
  topUp: TopUp;
  onTopUp: () => void;
}) {
  const balance = wallet ? `${Number(wallet.payer.usdc_balance).toFixed(2)} USDC` : failed ? "Unavailable" : "…";
  const address = wallet && !demo ? shortHash(wallet.payer.address) : "Demo replay";
  const open = () => wallet?.payer.explorer_url && WebBrowser.openBrowserAsync(wallet.payer.explorer_url);
  return (
    <View style={styles.wallet}>
      <View style={styles.walletTop}>
        <View style={styles.walletIcon}>
          <SymbolView name="wallet.bifold.fill" size={18} tintColor={ink.white} fallback={<Text style={styles.walletIconText}>$</Text>} />
        </View>
        <Pressable onPress={open} disabled={demo || !wallet} accessibilityRole="link" style={styles.walletText}>
          <Text style={styles.walletName}>{demo ? "Demo wallet" : "Coinbase wallet"}</Text>
          <Text style={styles.walletAddress} numberOfLines={1}>
            {address}
            {SEP}Base Sepolia
          </Text>
        </Pressable>
        <View style={styles.balance}>
          <Text style={styles.balanceValue}>{balance}</Text>
          <Text style={styles.balanceLabel}>Balance</Text>
        </View>
      </View>
      {short && (
        <View style={styles.short}>
          <Text style={styles.shortText}>
            {topUp === "requested"
              ? "Test USDC is on its way. The balance updates in a few seconds."
              : topUp === "limited"
                ? "The testnet faucet is busy. Try again in a minute."
                : "Not enough USDC for this booking."}
          </Text>
          {topUp !== "requested" && (
            <Pressable
              onPress={onTopUp}
              disabled={topUp === "requesting"}
              accessibilityRole="button"
              style={({ pressed }) => [styles.topUp, pressed && { opacity: 0.85 }]}
            >
              {topUp === "requesting" ? <ActivityIndicator color={ink.black} /> : <Text style={styles.topUpText}>Add test USDC</Text>}
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function Steps({ step }: { step: PaymentPhase | null }) {
  const done = step ? STEPS.findIndex((s) => s.phase === step) + 1 : 0;
  return (
    <View style={styles.steps} accessibilityLiveRegion="polite">
      {STEPS.map((s, i) => {
        const state = i < done ? "done" : i === done ? "current" : "pending";
        return (
          <View key={s.phase} style={styles.step} accessibilityLabel={`${s.label}: ${state}`}>
            <View style={[styles.dot, state === "done" && styles.dotDone, state === "pending" && styles.dotPending]}>
              {state === "done" ? (
                <SymbolView name="checkmark" size={11} weight="bold" tintColor={ink.white} fallback={<Text style={styles.check}>✓</Text>} />
              ) : state === "current" ? (
                <ActivityIndicator size="small" color={status.driveway} />
              ) : null}
            </View>
            <Text style={[styles.stepLabel, state === "pending" && styles.stepPending]}>{s.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Review the payment, approve it from the checkout wallet, then watch it settle. */
export function PaymentSheet(props: Props) {
  const { driveway, booking, phase, error, demo, wallet, walletFailed, topUp, step, onTopUp, onPay, onCancel } = props;
  const processing = phase === "processing";
  const amount = `${Number(booking.amount_usdc).toFixed(2)} USDC`;
  const short = !!wallet && Number(wallet.payer.usdc_balance) < Number(booking.amount_usdc);
  const payee = wallet && !demo ? `Owner ${shortHash(wallet.payee.address)}` : "Driveway owner";

  return (
    <View>
      <Text style={styles.title} accessibilityRole="header">
        {processing ? "Paying the owner" : phase === "failed" ? "Payment didn't go through" : "Confirm and pay"}
      </Text>
      <Text style={styles.subtitle}>
        {processing ? "This takes a few seconds. Your hold stays in place." : "The driveway is on hold for you while you pay."}
      </Text>

      {processing ? (
        <Steps step={step} />
      ) : (
        <>
          <WalletCard wallet={wallet} failed={walletFailed} demo={demo} short={short} topUp={topUp} onTopUp={onTopUp} />
          <View style={styles.card}>
            <Row label="Driveway" value={`Today, ${formatHhmm(driveway.availability_start)} to ${formatHhmm(driveway.availability_end)}`} />
            <Row label="Pay to" value={payee} />
            <Row label="Amount" value={amount} />
            <Row label="Network fee" value={demo ? "None (demo)" : "Covered by Coinbase"} />
          </View>
        </>
      )}

      {error && !processing && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      {!processing && (
        <>
          <Pressable
            onPress={onPay}
            disabled={short}
            accessibilityRole="button"
            accessibilityState={{ disabled: short }}
            style={({ pressed }) => [styles.cta, short && styles.ctaDisabled, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.ctaText}>{phase === "failed" ? "Retry payment" : `Approve ${amount}`}</Text>
          </Pressable>
          <Pressable onPress={onCancel} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}>
            <Text style={styles.secondaryText}>Cancel hold</Text>
          </Pressable>
        </>
      )}
      {demo && <Text style={styles.note}>Demo replay: no money moves and no transaction is created.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: font.bold, fontSize: 20, color: ink.black, marginHorizontal: 4, marginTop: 4 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: ink.grey500, marginHorizontal: 4, marginTop: 2 },

  wallet: { marginTop: 12, padding: 12, borderRadius: radius.button, borderWidth: 1, borderColor: ink.grey300, gap: 10 },
  walletTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  walletIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  walletIconText: { fontFamily: font.bold, fontSize: 15, color: ink.white },
  walletText: { flex: 1 },
  walletName: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  walletAddress: { fontFamily: font.regular, fontSize: 12, color: ink.grey500 },
  balance: { alignItems: "flex-end" },
  balanceValue: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  balanceLabel: { fontFamily: font.regular, fontSize: 12, color: ink.grey500 },
  short: { flexDirection: "row", alignItems: "center", gap: 10 },
  shortText: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: ink.black },
  topUp: { height: 34, paddingHorizontal: 12, borderRadius: radius.control, backgroundColor: ink.grey100, justifyContent: "center" },
  topUpText: { fontFamily: font.bold, fontSize: 13, color: ink.black, marginTop: 2 },

  card: { marginTop: 10, padding: 12, borderRadius: radius.button, backgroundColor: ink.grey100, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { fontFamily: font.regular, fontSize: 14, color: ink.grey500 },
  rowValue: { flexShrink: 1, fontFamily: font.semibold, fontSize: 14, color: ink.black, textAlign: "right" },

  steps: { marginTop: 14, marginHorizontal: 4, gap: 14 },
  step: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  dotDone: { backgroundColor: status.driveway },
  dotPending: { borderWidth: 1.5, borderColor: ink.grey300 },
  check: { color: ink.white, fontFamily: font.bold, fontSize: 11 },
  stepLabel: { fontFamily: font.semibold, fontSize: 15, color: ink.black, marginTop: 2 },
  stepPending: { color: ink.grey500 },

  note: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, marginTop: 8, marginHorizontal: 4, textAlign: "center" },
  error: { fontFamily: font.semibold, fontSize: 13, color: ink.black, marginTop: 8, marginHorizontal: 4 },
  cta: { marginTop: 12, height: 52, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  ctaDisabled: { backgroundColor: ink.grey300 },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
  secondary: { marginTop: 8, height: 44, borderRadius: radius.control, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
});
