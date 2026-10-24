import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import type { Booking, Driveway } from "@/api/types";
import { explorerUrl, shortHash } from "@/components/find/BookingConfirmation";
import { DrivewayPhoto } from "@/components/find/DrivewayDetailSheet";
import { font, ink, radius, status } from "@/config/tokens";
import { formatUsdc } from "@/features/find/options";
import { formatHhmm, formatLaClock, inLaWindow } from "@/lib/laTime";

import { draftOf, PRICE_RANGE, sameDraft, shiftWindow, useDrivewayActions, type DrivewayDraft } from "./useDriveway";

type Props = {
  driveway: Driveway;
  booking: Booking | null;
  onConflict: () => void;
};

const STATE_LABEL: Record<Driveway["state"], string> = {
  AVAILABLE: "Listed",
  UNAVAILABLE: "Hidden",
  HELD: "Payment in progress",
  BOOKED: "Booked",
};

function Stepper({ label, value, onMinus, onPlus, disabled }: { label: string; value: string; onMinus: () => void; onPlus: () => void; disabled: boolean }) {
  const btn = (sign: "-" | "+", onPress: () => void) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${sign === "-" ? "Decrease" : "Increase"} ${label.toLowerCase()}`}
      hitSlop={6}
      style={({ pressed }) => [styles.stepBtn, disabled && { opacity: 0.35 }, pressed && { backgroundColor: ink.grey300 }]}
    >
      <SymbolView name={sign === "-" ? "minus" : "plus"} size={14} weight="bold" tintColor={ink.black} fallback={<Text style={styles.stepSign}>{sign}</Text>} />
    </Pressable>
  );
  return (
    <View style={styles.stepRow} accessible={false}>
      <Text style={styles.stepLabel}>{label}</Text>
      <View style={styles.stepControls}>
        {btn("-", onMinus)}
        <Text style={styles.stepValue} accessibilityLabel={`${label} ${value}`}>
          {value}
        </Text>
        {btn("+", onPlus)}
      </View>
    </View>
  );
}

/** Owner controls for the seeded driveway listing. */
export function DrivewayEditor({ driveway, booking, onConflict }: Props) {
  const { busy, message, save, recover, clearMessage } = useDrivewayActions(onConflict);
  const [draft, setDraft] = useState<DrivewayDraft>(() => draftOf(driveway));

  // Server state wins whenever the listing changes (another device, a booking, a conflict).
  useEffect(() => {
    setDraft(draftOf(driveway));
  }, [driveway]);

  const locked = driveway.state === "HELD" || driveway.state === "BOOKED";
  const dirty = !sameDraft(draft, draftOf(driveway));
  const edit = (next: DrivewayDraft) => {
    clearMessage();
    setDraft(next);
  };
  const inWindow = inLaWindow(driveway.availability_start, driveway.availability_end, new Date());

  return (
    <View style={styles.root}>
      <DrivewayPhoto uri={driveway.photo_url} />

      <View style={styles.titleRow}>
        <View style={styles.titleText}>
          <Text style={styles.title} accessibilityRole="header">
            Driveway on Fillmore St
          </Text>
          <Text style={styles.subtitle}>
            {driveway.state === "AVAILABLE"
              ? inWindow
                ? "Drivers can reserve it now"
                : "Outside your window right now"
              : driveway.state === "UNAVAILABLE"
                ? "Hidden from drivers"
                : driveway.state === "HELD"
                  ? "A driver is checking out"
                  : `Reserved until ${formatHhmm(driveway.availability_end)}`}
          </Text>
        </View>
        <View style={[styles.pill, driveway.state === "BOOKED" && styles.pillBooked, driveway.state === "HELD" && styles.pillHeld]}>
          <Text style={[styles.pillText, (driveway.state === "BOOKED" || driveway.state === "HELD") && styles.pillTextOn]}>
            {STATE_LABEL[driveway.state]}
          </Text>
        </View>
      </View>

      {driveway.state === "HELD" && (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <ActivityIndicator color={ink.black} />
          <View style={styles.noticeText}>
            <Text style={styles.noticeTitle}>Payment in progress</Text>
            <Text style={styles.noticeBody}>The hold stays until the driver pays or cancels. There&apos;s no timeout.</Text>
          </View>
        </View>
      )}

      {driveway.state === "BOOKED" && booking && (
        <View style={styles.receipt}>
          <Text style={styles.receiptTitle}>Booking receipt</Text>
          <View style={styles.receiptRow}>
            <Text style={styles.receiptLabel}>Paid</Text>
            <Text style={styles.receiptValue}>{Number(booking.amount_usdc).toFixed(2)} USDC</Text>
          </View>
          {booking.confirmed_at && (
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Confirmed</Text>
              <Text style={styles.receiptValue}>{formatLaClock(booking.confirmed_at)}</Text>
            </View>
          )}
          <View style={styles.receiptRow}>
            <Text style={styles.receiptLabel}>Transaction</Text>
            {booking.transaction_hash ? (
              <Pressable onPress={() => WebBrowser.openBrowserAsync(explorerUrl(booking.transaction_hash!))} accessibilityRole="link" hitSlop={8}>
                <Text style={styles.link}>{shortHash(booking.transaction_hash)}</Text>
              </Pressable>
            ) : (
              <Text style={styles.receiptValue}>None (demo replay)</Text>
            )}
          </View>
        </View>
      )}

      <View style={[styles.controls, locked && { opacity: 0.5 }]} pointerEvents={locked ? "none" : "auto"}>
        <View style={styles.stepRow}>
          <Text style={styles.stepLabel}>Available to book</Text>
          <Switch
            value={draft.available}
            onValueChange={(available) => edit({ ...draft, available })}
            disabled={locked}
            trackColor={{ true: ink.black, false: ink.grey300 }}
            accessibilityLabel="Available to book"
          />
        </View>
        <Stepper
          label="Price"
          value={formatUsdc(draft.price.toFixed(2))}
          disabled={locked}
          onMinus={() => edit({ ...draft, price: Math.max(PRICE_RANGE.min, draft.price - 1) })}
          onPlus={() => edit({ ...draft, price: Math.min(PRICE_RANGE.max, draft.price + 1) })}
        />
        <Stepper label="From" value={formatHhmm(draft.start)} disabled={locked} onMinus={() => edit(shiftWindow(draft, "start", -60))} onPlus={() => edit(shiftWindow(draft, "start", 60))} />
        <Stepper label="Until" value={formatHhmm(draft.end)} disabled={locked} onMinus={() => edit(shiftWindow(draft, "end", -60))} onPlus={() => edit(shiftWindow(draft, "end", 60))} />
      </View>

      {message && (
        <Text style={styles.message} accessibilityLiveRegion="polite">
          {message}
        </Text>
      )}

      {driveway.state === "HELD" ? (
        <Pressable
          onPress={() => recover(driveway)}
          disabled={busy === "recover"}
          accessibilityRole="button"
          accessibilityHint="Releases an abandoned hold. Not possible while a payment is processing."
          style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}
        >
          {busy === "recover" ? <ActivityIndicator color={ink.black} /> : <Text style={styles.secondaryText}>Return to available</Text>}
        </Pressable>
      ) : (
        !locked && (
          <Pressable
            onPress={() => save(driveway, draft)}
            disabled={!dirty || busy === "save"}
            accessibilityRole="button"
            accessibilityState={{ disabled: !dirty }}
            style={({ pressed }) => [styles.cta, !dirty && styles.ctaDisabled, pressed && { opacity: 0.85 }]}
          >
            {busy === "save" ? <ActivityIndicator color={ink.white} /> : <Text style={styles.ctaText}>Save changes</Text>}
          </Pressable>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  titleText: { flex: 1 },
  title: { fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 2 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  pill: { paddingHorizontal: 10, height: 26, borderRadius: radius.pill, backgroundColor: ink.grey100, justifyContent: "center" },
  pillHeld: { backgroundColor: ink.black },
  pillBooked: { backgroundColor: status.driveway },
  pillText: { fontFamily: font.bold, fontSize: 12, color: ink.black, marginTop: 2 },
  pillTextOn: { color: ink.white },
  notice: { flexDirection: "row", gap: 12, alignItems: "center", padding: 12, borderRadius: radius.button, backgroundColor: ink.grey100 },
  noticeText: { flex: 1 },
  noticeTitle: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  noticeBody: { fontFamily: font.regular, fontSize: 13, color: ink.grey700 },
  receipt: { padding: 12, borderRadius: radius.button, backgroundColor: ink.grey100, gap: 6 },
  receiptTitle: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  receiptRow: { flexDirection: "row", justifyContent: "space-between" },
  receiptLabel: { fontFamily: font.regular, fontSize: 14, color: ink.grey500 },
  receiptValue: { fontFamily: font.semibold, fontSize: 14, color: ink.black },
  link: { fontFamily: font.bold, fontSize: 14, color: ink.black, textDecorationLine: "underline" },
  controls: { borderRadius: radius.button, borderWidth: 1, borderColor: ink.grey100, paddingHorizontal: 12 },
  stepRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 54, borderBottomWidth: 1, borderBottomColor: ink.grey100 },
  stepLabel: { fontFamily: font.semibold, fontSize: 15, color: ink.black, marginTop: 2 },
  stepControls: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  stepSign: { fontFamily: font.bold, fontSize: 16, color: ink.black },
  stepValue: { minWidth: 72, textAlign: "center", fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  message: { fontFamily: font.semibold, fontSize: 13, color: ink.black },
  cta: { height: 52, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  ctaDisabled: { backgroundColor: ink.grey300 },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
  secondary: { height: 48, borderRadius: radius.control, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
});
