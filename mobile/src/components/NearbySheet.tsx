import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";

import { font, ink, radius } from "@/config/tokens";
import type { FindOption } from "@/features/find/options";
import type { ParkingLoad } from "@/features/find/useParkingState";

import { OptionIcon } from "./OptionIcon";

type Props = {
  options: FindOption[];
  load: ParkingLoad;
  selectedId: string | null;
  onSelect: (option: FindOption) => void;
  onRetry: () => void;
  bottomInset: number;
  onContentHeight?: (height: number) => void;
};

const MAX_ROWS = 4;

/** Ranked nearby options: fresh curb openings first, then the guaranteed driveway, then aging. */
export function NearbySheet({ options, load, selectedId, onSelect, onRetry, bottomInset, onContentHeight }: Props) {
  const rows = options.slice(0, MAX_ROWS);

  return (
    <BottomSheet enableDynamicSizing backgroundStyle={styles.sheet} handleIndicatorStyle={styles.handle} enablePanDownToClose={false}>
      <BottomSheetView
        style={[styles.content, { paddingBottom: bottomInset + 10 }]}
        onLayout={(e: LayoutChangeEvent) => onContentHeight?.(e.nativeEvent.layout.height)}
      >
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Parking near you
          </Text>
          <Text style={styles.subtitle}>Within 0.5 mi</Text>
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

        {load === "ready" && rows.length > 0 && (
          <View accessibilityRole="radiogroup">
            {rows.map((o) => {
              const isSel = o.id === selectedId;
              return (
                <Pressable
                  key={o.id}
                  onPress={() => onSelect(o)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSel }}
                  accessibilityLabel={`${o.title}. ${o.detail}. ${o.trailing}`}
                  style={({ pressed }) => [styles.row, isSel && styles.rowSelected, pressed && !isSel && styles.rowPressed]}
                >
                  <OptionIcon kind={o.kind} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{o.title}</Text>
                    <Text style={styles.rowDetail} numberOfLines={1}>
                      {o.detail}
                    </Text>
                  </View>
                  <Text style={styles.trailing}>{o.trailing}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: ink.white, borderRadius: radius.sheet },
  handle: { backgroundColor: ink.grey300, width: 36 },
  content: { paddingHorizontal: 12 },
  header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginHorizontal: 4, marginBottom: 6 },
  title: { fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 2 },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 58,
    paddingHorizontal: 10,
    borderRadius: radius.button,
    borderWidth: 2,
    borderColor: "transparent",
  },
  rowSelected: { borderColor: ink.black },
  rowPressed: { backgroundColor: ink.grey100 },
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
