import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, SEP, status } from "@/config/tokens";
import type { FindOption } from "@/features/find/options";
import type { ParkingLoad } from "@/features/find/useParkingState";

import { OptionIcon } from "../OptionIcon";

type Props = {
  options: FindOption[];
  /** The driver's booked driveway, pinned above the list. */
  reservation?: FindOption | null;
  load: ParkingLoad;
  /** Live mode waiting for the first location fix. */
  locating?: boolean;
  onOpen: (option: FindOption) => void;
  onRetry: () => void;
};

const MAX_ROWS = 4;

/** Ranked nearby options: fresh curb openings first, then the guaranteed driveway, then aging. */
export function NearbyList({ options, reservation = null, load, locating = false, onOpen, onRetry }: Props) {
  const rows = options.filter((o) => o.id !== reservation?.id).slice(0, MAX_ROWS);

  return (
    <View>
      {reservation && (
        <Pressable
          onPress={() => onOpen(reservation)}
          accessibilityRole="button"
          accessibilityLabel={`Your reservation. ${reservation.detail}`}
          accessibilityHint="Opens the receipt and route"
          style={({ pressed }) => [styles.reservation, pressed && styles.rowPressed]}
        >
          <OptionIcon kind="driveway" mine />
          <View style={styles.rowText}>
            <Text style={styles.reservationLabel}>Your reservation</Text>
            <Text style={styles.rowTitle}>Private driveway</Text>
            <Text style={styles.rowDetail} numberOfLines={1}>
              {reservation.detail}
            </Text>
          </View>
          <Text style={styles.trailing}>Receipt</Text>
        </Pressable>
      )}

      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Parking near you
        </Text>
        <Text style={styles.subtitle}>{load === "ready" && options.length > 0 ? `${options.length} nearby${SEP}0.5 mi` : "Within 0.5 mi"}</Text>
      </View>

      {load === "loading" && (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <ActivityIndicator color={ink.black} />
          <Text style={styles.stateText}>Checking nearby curbs</Text>
        </View>
      )}

      {load === "error" && (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <Text style={styles.stateTitle}>Can&apos;t reach Curb right now</Text>
          <Text style={styles.stateText}>Your map stays usable. We&apos;ll keep trying.</Text>
          <Pressable onPress={onRetry} accessibilityRole="button" style={({ pressed }) => [styles.retry, pressed && { opacity: 0.8 }]}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {load === "ready" && rows.length === 0 && (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>No openings seen nearby yet</Text>
          <Text style={styles.stateText}>Blue curbs are legal to park now. Openings appear here as cars pass.</Text>
        </View>
      )}

      {load === "ready" &&
        rows.map((o) => (
          <Pressable
            key={o.id}
            onPress={() => onOpen(o)}
            accessibilityRole="button"
            accessibilityLabel={`${o.title}. ${o.detail}. ${o.trailing}`}
            accessibilityHint="Opens details"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <OptionIcon kind={o.kind} mine={o.mine} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{o.title}</Text>
              <Text style={styles.rowDetail} numberOfLines={1}>
                {o.detail}
              </Text>
            </View>
            <Text style={styles.trailing}>{o.trailing}</Text>
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginHorizontal: 4, marginBottom: 6 },
  title: { fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 2 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, height: 58, paddingHorizontal: 10, borderRadius: radius.button },
  rowPressed: { backgroundColor: ink.grey100 },
  reservation: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    marginBottom: 10,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: status.driveway,
  },
  reservationLabel: { fontFamily: font.semibold, fontSize: 12, color: status.driveway, marginTop: 2 },
  rowText: { flex: 1 },
  rowTitle: { fontFamily: font.bold, fontSize: 16, color: ink.black, marginTop: 2 },
  rowDetail: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  trailing: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 2 },
  state: { alignItems: "center", paddingVertical: 22, paddingHorizontal: 16, gap: 6 },
  stateTitle: { fontFamily: font.bold, fontSize: 16, color: ink.black, textAlign: "center" },
  stateText: { fontFamily: font.regular, fontSize: 14, color: ink.grey500, textAlign: "center" },
  retry: { marginTop: 8, height: 40, paddingHorizontal: 18, borderRadius: radius.control, backgroundColor: ink.black, justifyContent: "center" },
  retryText: { fontFamily: font.bold, fontSize: 14, color: ink.white, marginTop: 2 },
});
