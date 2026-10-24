import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

type Props = {
  children: ReactNode;
  /** Size of the area the window can move in (the Find screen). */
  areaWidth: number;
  areaHeight: number;
  /** Keep clear of the top controls and of the bottom sheet. */
  topInset: number;
  bottomInset: number;
  reduceMotion: boolean;
};

const MARGIN = 16;
const SPRING = { damping: 20, stiffness: 220, mass: 0.8 };

/**
 * A floating picture-in-picture window: drag it anywhere, and on release it
 * settles against the nearest side, like iOS video PiP. Taps on its content
 * still work; the drag only starts after a few points of movement.
 */
export function DraggablePip({ children, areaWidth, areaHeight, topInset, bottomInset, reduceMotion }: Props) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const x = useSharedValue(MARGIN);
  const y = useSharedValue(topInset);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const placed = useSharedValue(false);

  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const minY = topInset;
  const maxY = Math.max(minY, areaHeight - bottomInset - h - 12);
  const maxX = Math.max(MARGIN, areaWidth - w - MARGIN);

  // Start top-left; afterwards keep the window in bounds when the sheet or screen changes.
  useEffect(() => {
    if (!size || !areaHeight) return;
    if (!placed.get()) {
      x.set(MARGIN);
      y.set(minY);
      placed.set(true);
      return;
    }
    const clampedY = Math.min(Math.max(y.get(), minY), maxY);
    if (clampedY !== y.get()) y.set(reduceMotion ? clampedY : withSpring(clampedY, SPRING));
    if (x.get() > maxX) x.set(maxX);
  }, [size, areaHeight, minY, maxY, maxX, reduceMotion, x, y, placed]);

  const pan = Gesture.Pan()
    .minDistance(6)
    .onStart(() => {
      startX.set(x.get());
      startY.set(y.get());
    })
    .onUpdate((e) => {
      x.set(Math.min(Math.max(startX.get() + e.translationX, MARGIN), maxX));
      y.set(Math.min(Math.max(startY.get() + e.translationY, minY), maxY));
    })
    .onEnd((e) => {
      // Settle on the side the window (or the fling) is heading toward.
      const center = x.get() + w / 2 + e.velocityX * 0.1;
      const targetX = center < areaWidth / 2 ? MARGIN : maxX;
      const targetY = Math.min(Math.max(y.get() + e.velocityY * 0.05, minY), maxY);
      x.set(reduceMotion ? targetX : withSpring(targetX, SPRING));
      y.set(reduceMotion ? targetY : withSpring(targetY, SPRING));
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.pip, style, !size && styles.hidden]}
        onLayout={(e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        accessibilityHint="Drag to move"
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  pip: { position: "absolute", top: 0, left: 0, zIndex: 5 },
  hidden: { opacity: 0 },
});
