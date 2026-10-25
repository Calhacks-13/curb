import { useState } from "react";
import { Platform, StyleSheet, Text, View, type ViewProps } from "react-native";
import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { font } from "@/config/tokens";
import { ghostPlacements } from "@/features/capture/ghostPlacement";
import type { DeepReadonly } from "@/features/capture/DetectionUploadController";
import { projectCoverBox } from "./DetectionOverlay";

type NativeProps = ViewProps & { yaw: number };
function Car(props: NativeProps) {
  const [NativeCar] = useState(() => {
    if (Platform.OS !== "ios") return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("expo") as typeof import("expo")).requireNativeView<NativeProps>("CurbGhost");
  });
  return NativeCar ? <NativeCar {...props} /> : null;
}

export function GhostParkingOverlay({ inference, analysis, compact }: {
  inference: OnDeviceInference | null; analysis: DeepReadonly<FrameAccepted> | null; compact: boolean;
}) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const placements = ghostPlacements(inference, analysis);
  return <View testID="ghost-parking-overlay" pointerEvents="none" style={StyleSheet.absoluteFill}
    onLayout={({ nativeEvent: { layout } }) => setViewport((size) => size.width === layout.width && size.height === layout.height ? size : { width: layout.width, height: layout.height })}>
    {placements.map((placement) => {
      const box = projectCoverBox(placement.bbox, { width: inference!.frameWidth, height: inference!.frameHeight }, viewport);
      if (!box || Number(box.width) < (compact ? 20 : 72)) return null;
      return <View key={placement.key} style={[styles.placement, box]} accessible accessibilityLabel="3D parking preview. Size and fit unverified.">
        <Car yaw={placement.yaw} style={StyleSheet.absoluteFill} />
        {!compact && <Text style={styles.caption}>Parking preview · fit unverified</Text>}
      </View>;
    })}
  </View>;
}
const styles = StyleSheet.create({
  placement: { position: "absolute" },
  caption: { position: "absolute", top: "100%", alignSelf: "center", textAlign: "center", color: "#FFFFFF", fontFamily: font.semibold,
    fontSize: 10, lineHeight: 15, width: 195, textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
});
