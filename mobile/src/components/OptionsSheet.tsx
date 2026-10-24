import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";

import { font, ink, radius } from "@/config/tokens";
import type { SpotOption } from "@/data/spots";

import { SpotIcon } from "./SpotIcon";

type Props = {
  title: string;
  options: SpotOption[];
  selectedId: string | null;
  onSelect: (option: SpotOption) => void;
  onGo: () => void;
  bottomInset: number;
  onContentHeight?: (height: number) => void;
};

/** Ride-picker style list: one row per option, selected row outlined in black. */
export function OptionsSheet({ title, options, selectedId, onSelect, onGo, bottomInset, onContentHeight }: Props) {
  const selected = options.find((o) => o.segmentId === selectedId);

  return (
    <BottomSheet enableDynamicSizing backgroundStyle={styles.sheet} handleIndicatorStyle={styles.handle} enablePanDownToClose={false}>
      <BottomSheetView
        style={[styles.content, { paddingBottom: bottomInset + 8 }]}
        onLayout={(e: LayoutChangeEvent) => onContentHeight?.(e.nativeEvent.layout.height)}
      >
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>

        <View accessibilityRole="radiogroup">
          {options.map((o) => {
            const isSel = o.segmentId === selectedId;
            return (
              <Pressable
                key={o.segmentId}
                onPress={() => onSelect(o)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSel }}
                accessibilityLabel={`${o.title}, ${o.price}, ${o.walkMinutes} minute walk. ${o.detail}`}
                style={({ pressed }) => [styles.row, isSel && styles.rowSelected, pressed && !isSel && styles.rowPressed]}
              >
                <SpotIcon kind={o.kind} />
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{o.title}</Text>
                  <Text style={styles.rowDetail} numberOfLines={1}>
                    {o.walkMinutes} min walk · {o.detail}
                  </Text>
                </View>
                <Text style={styles.price}>{o.price}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={onGo}
          disabled={!selected}
          accessibilityRole="button"
          accessibilityState={{ disabled: !selected }}
          style={({ pressed }) => [styles.cta, !selected && styles.ctaDisabled, pressed && styles.ctaPressed]}
        >
          <Text style={styles.ctaText}>Go to this spot</Text>
        </Pressable>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: ink.white, borderRadius: radius.sheet },
  handle: { backgroundColor: ink.grey300, width: 36 },
  content: { paddingHorizontal: 12, paddingTop: 0 },
  title: { fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 2, marginBottom: 6, marginLeft: 4 },
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
  price: { fontFamily: font.bold, fontSize: 16, color: ink.black, marginTop: 2 },
  cta: {
    marginTop: 8,
    height: 52,
    borderRadius: radius.control,
    backgroundColor: ink.black,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaDisabled: { backgroundColor: ink.grey300 },
  ctaPressed: { opacity: 0.85 },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
});
