import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View, type ViewProps } from "react-native";
import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { font } from "@/config/tokens";
import { ghostPreviewState } from "@/features/capture/ghostPlacement";
import type { DeepReadonly } from "@/features/capture/DetectionUploadController";
import { projectCoverBox } from "./DetectionOverlay";

type RenderStatus = "loaded" | "rendered" | "error";
type NativeProps = ViewProps & { yaw: number; onStatus: (event: { nativeEvent: { state: RenderStatus } }) => void };
function Car(props: NativeProps) {
  const [NativeCar] = useState(() => {
    if (Platform.OS !== "ios") return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require("expo") as typeof import("expo")).requireNativeView<NativeProps>("CurbGhost");
    } catch { return null; }
  });
  const onStatus = props.onStatus;
  useEffect(() => {
    if (!NativeCar) onStatus({ nativeEvent: { state: "error" } });
  }, [NativeCar, onStatus]);
  return NativeCar ? <NativeCar {...props} /> : null;
}

export function GhostParkingOverlay({ inference, analysis, submitted = inference, compact, onStatusChange }: {
  inference: OnDeviceInference | null; analysis: DeepReadonly<FrameAccepted> | null;
  submitted?: DeepReadonly<OnDeviceInference> | null; compact: boolean; onStatusChange?: (detail: string) => void;
}) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [models, setModels] = useState<Record<string, RenderStatus>>({});
  const preview = ghostPreviewState(inference, analysis, submitted);
  const visible = preview.placements.map((placement) => ({ ...placement,
    box: projectCoverBox(placement.bbox, { width: inference!.frameWidth, height: inference!.frameHeight }, viewport),
  })).filter(({ box }) => box && Number(box.width) >= (compact ? 20 : 72)
    && Number(box.left) < viewport.width && Number(box.left) + Number(box.width) > 0);
  const detail = !preview.placements.length ? preview.detail : !visible.length ? "Opening too small on screen — move closer"
    : visible.some(({ key }) => models[key] === "error") ? "3D model unavailable — reopen the updated app"
      : visible.some(({ key }) => models[key] === "rendered") ? "3D model rendered"
        : "Loading 3D model";
  useEffect(() => { onStatusChange?.(detail); }, [detail, onStatusChange]);
  return <View testID="ghost-parking-overlay" pointerEvents="none" style={StyleSheet.absoluteFill}
    onLayout={({ nativeEvent: { layout } }) => setViewport((size) => size.width === layout.width && size.height === layout.height ? size : { width: layout.width, height: layout.height })}>
    {visible.map((placement) => <View key={placement.key} style={[styles.placement, placement.box]}
      accessible accessibilityLabel="3D parking preview. Size and fit unverified.">
      <Car yaw={placement.yaw} style={StyleSheet.absoluteFill} onStatus={({ nativeEvent }) => setModels((current) =>
        current[placement.key] === nativeEvent.state ? current : Object.fromEntries(Object.entries({ ...current, [placement.key]: nativeEvent.state }).slice(-8)))} />
      {!compact && <Text style={styles.caption}>Parking preview · fit unverified</Text>}
    </View>)}
  </View>;
}
const styles = StyleSheet.create({
  placement: { position: "absolute" },
  caption: { position: "absolute", top: "100%", alignSelf: "center", textAlign: "center", color: "#FFFFFF", fontFamily: font.semibold,
    fontSize: 10, lineHeight: 15, width: 195, textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
});
