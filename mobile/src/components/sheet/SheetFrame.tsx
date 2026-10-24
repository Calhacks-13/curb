import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";

import { ink, radius } from "@/config/tokens";

/** Collapsed height: the handle plus the content's header line. */
export const SHEET_PEEK = 78;

type Props = {
  children: ReactNode;
  bottomInset: number;
  /** Reports the content height so the map can keep targets above the sheet. */
  onContentHeight?: (height: number) => void;
  /** True while swiped down to the peek, so the map can use the space. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Changing this re-opens the sheet (e.g. a spot was tapped on the map while collapsed). */
  expandKey?: string;
};

/**
 * The single Find bottom sheet; content swaps between list, details and route.
 * Swipe down to a slim peek to see the whole map, swipe up to bring it back.
 */
export function SheetFrame({ children, bottomInset, onContentHeight, onCollapsedChange, expandKey }: Props) {
  const sheet = useRef<BottomSheet>(null);

  useEffect(() => {
    sheet.current?.expand();
  }, [expandKey]);

  return (
    <BottomSheet
      ref={sheet}
      index={1}
      snapPoints={[SHEET_PEEK]}
      enableDynamicSizing
      enablePanDownToClose={false}
      onChange={(index) => onCollapsedChange?.(index === 0)}
      backgroundStyle={styles.sheet}
      handleIndicatorStyle={styles.handle}
      accessibilityLabel="Parking sheet. Swipe down to show the full map."
    >
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
