import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import type { ReactNode } from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";

import { ink, radius } from "@/config/tokens";

type Props = {
  children: ReactNode;
  bottomInset: number;
  /** Reports the content height so the map can keep targets above the sheet. */
  onContentHeight?: (height: number) => void;
};

/** The single Find bottom sheet; content swaps between list, details and route. */
export function SheetFrame({ children, bottomInset, onContentHeight }: Props) {
  return (
    <BottomSheet enableDynamicSizing backgroundStyle={styles.sheet} handleIndicatorStyle={styles.handle} enablePanDownToClose={false}>
      <BottomSheetView
        style={[styles.content, { paddingBottom: bottomInset + 10 }]}
        onLayout={(e: LayoutChangeEvent) => onContentHeight?.(e.nativeEvent.layout.height)}
      >
        {children}
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: ink.white, borderRadius: radius.sheet },
  handle: { backgroundColor: ink.grey300, width: 36 },
  content: { paddingHorizontal: 12 },
});
