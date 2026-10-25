import { useMemo, useState } from "react";
import type { LayoutChangeEvent, ViewStyle } from "react-native";
import { StyleSheet, Text, View } from "react-native";

import type { DetectionBox, FrameAccepted, OnDeviceInference } from "@/api/types";
import { font } from "@/config/tokens";
import { vision } from "@/config/vision";
import type { DeepReadonly } from "@/features/capture/DetectionUploadController";

type Size = { width: number; height: number };
type Props = {
  result: OnDeviceInference | null;
  analysis?: DeepReadonly<FrameAccepted> | null;
  compact?: boolean;
  showSummary?: boolean;
  showGaps?: boolean;
  showLabels?: boolean;
};

export function projectCoverBox(box: Readonly<DetectionBox>, frame: Size, viewport: Size): ViewStyle | null {
  if (frame.width <= 0 || frame.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const scale = Math.max(viewport.width / frame.width, viewport.height / frame.height);
  const offsetX = (viewport.width - frame.width * scale) / 2;
  const offsetY = (viewport.height - frame.height * scale) / 2;
  const [x1, y1, x2, y2] = box;
  const projected = { left: x1 * scale + offsetX, top: y1 * scale + offsetY,
    width: (x2 - x1) * scale, height: (y2 - y1) * scale };
  return Object.values(projected).every(Number.isFinite) && projected.width > 0 && projected.height > 0 ? projected : null;
}

function visibleArea(box: ViewStyle, viewport: Size) {
  const left = Math.max(0, Number(box.left));
  const top = Math.max(0, Number(box.top));
  const width = Math.min(viewport.width, Number(box.left) + Number(box.width)) - left;
  const height = Math.min(viewport.height, Number(box.top) + Number(box.height)) - top;
  return { width, height, left: left - Number(box.left), top: top - Number(box.top) };
}

/** Thin contours, distinct corner brackets, and labels anchored inside the visible image. */
export function DetectionOverlay({ result, analysis, compact = false, showSummary = true, showGaps = true, showLabels = true }: Props) {
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const detections = useMemo(() => {
    if (!result) return [];
    const frame = { width: result.frameWidth, height: result.frameHeight };
    return [
      ...result.vehicles.map((vehicle, index) => ({ key: `vehicle-${index}`, label: vehicle.cls,
        accessibilityLabel: `${vehicle.cls}, ${Math.round(vehicle.confidence * 100)}% confidence`,
        confidence: vehicle.confidence, box: projectCoverBox(vehicle.bbox, frame, viewport), color: vision.vehicle })),
      ...result.signs.map((sign, index) => ({ key: `sign-${index}`, label: "sign",
        accessibilityLabel: `parking sign, ${Math.round(sign.confidence * 100)}% confidence`,
        confidence: sign.confidence, box: projectCoverBox(sign.bbox, frame, viewport), color: vision.sign })),
    ];
  }, [result, viewport]);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) => current.width === width && current.height === height ? current : { width, height });
  };
  const gaps = analysis?.frame_width && analysis.frame_height ? (analysis.gap_bboxes ?? []).map((bbox, index) => {
    const tracked = analysis.tracked_gaps?.find((gap) => gap.bbox.every((value, axis) => value === bbox[axis]));
    const state = tracked?.confirmed ? "Confirmed" : "Candidate";
    const size = tracked?.median_width_meters != null ? `${tracked.median_width_meters.toFixed(1)} m` : `${Math.round(bbox[2] - bbox[0])} px`;
    return { box: projectCoverBox(bbox, { width: analysis.frame_width!, height: analysis.frame_height! }, viewport),
      label: `Gap ${index + 1} · ${state} · ${size}${tracked ? ` · ${tracked.duration.toFixed(1)}s` : ""}`,
      state, confirmed: tracked?.confirmed };
  }) : [];
  const count = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  const status = !result ? "Waiting for detections" : result.vehicles.length + result.signs.length === 0 ? "No detections"
    : `${count(result.vehicles.length, "vehicle")} · ${count(result.signs.length, "sign")}`;

  return <View pointerEvents="none" testID="detection-overlay" onLayout={onLayout} style={StyleSheet.absoluteFill}>
    {showGaps && gaps.map((gap, index) => {
      if (!gap.box) return null;
      const area = visibleArea(gap.box, viewport);
      if (area.width <= 0 || area.height <= 0) return null;
      return <View key={`gap-${index}`} accessible accessibilityLabel={gap.label}
        style={[styles.gapBox, gap.confirmed && styles.confirmedGap, gap.box]}>
        {!compact && <View style={[styles.measurement, { top: area.top + area.height * 0.52, left: area.left + 3, width: Math.max(0, area.width - 6) }]}>
          <View style={styles.measureCap} /><View style={styles.measureLine} /><View style={styles.measureCap} />
        </View>}
        {area.width >= (compact ? 40 : 66) && <View style={[styles.gapLabel, { top: area.top + area.height * 0.42,
          left: area.left + Math.max(4, (area.width - 144) / 2), maxWidth: Math.max(0, area.width - 8) }]}>
          <View style={styles.labelRow}><View style={[styles.dot, { backgroundColor: vision.gap }]} />
            <Text style={styles.gapTitle}>{compact ? "GAP" : `GAP ${String(index + 1).padStart(2, "0")}`}</Text></View>
          {!compact && <Text style={[styles.gapState, gap.confirmed && styles.confirmedText]}>{gap.state.toUpperCase()}</Text>}
        </View>}
      </View>;
    })}
    {detections.map((detection) => {
      if (!detection.box) return null;
      const area = visibleArea(detection.box, viewport);
      if (area.width <= 0 || area.height <= 0) return null;
      const corner = Math.max(3, Math.min(compact ? 7 : 14, Number(detection.box.width) / 3, Number(detection.box.height) / 3));
      return <View key={detection.key} accessible accessibilityLabel={detection.accessibilityLabel}
        style={[styles.box, { borderColor: showLabels ? `${detection.color}66` : "transparent" }, detection.box]}>
        {([styles.topLeft, styles.topRight, styles.bottomLeft, styles.bottomRight]).map((position, index) =>
          <View key={index} style={[styles.corner, position, { borderColor: detection.color, width: corner, height: corner }]} />)}
        {showLabels && !compact && area.width >= 48 && area.height >= 28 && <View style={[styles.objectLabel,
          { left: area.left + 5, top: area.top + 5, maxWidth: area.width - 10 }]}>
          <View style={[styles.dot, { backgroundColor: detection.color }]} />
          <Text numberOfLines={1} style={styles.objectName}>{detection.label.toUpperCase()}</Text>
          {area.width >= 100 && <Text style={[styles.confidence, { color: detection.color }]}>{Math.round(detection.confidence * 100)}%</Text>}
        </View>}
      </View>;
    })}
    {showSummary && !compact && <View style={styles.statusPill}><Text style={styles.statusText}>{status}</Text></View>}
  </View>;
}

const styles = StyleSheet.create({
  box: { position: "absolute", borderWidth: 0.5, borderRadius: 4, backgroundColor: "transparent" },
  corner: { position: "absolute", borderColor: vision.vehicle },
  topLeft: { top: -0.5, left: -0.5, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 4 },
  topRight: { top: -0.5, right: -0.5, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 4 },
  bottomLeft: { bottom: -0.5, left: -0.5, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 4 },
  bottomRight: { bottom: -0.5, right: -0.5, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 4 },
  objectLabel: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 5, minHeight: 23,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.78)", borderWidth: 0.5, borderColor: "rgba(255,255,255,0.13)" },
  objectName: { fontFamily: font.bold, fontSize: 9, letterSpacing: 0.8, color: vision.text, flexShrink: 1 },
  confidence: { fontFamily: font.semibold, fontSize: 9, fontVariant: ["tabular-nums"] },
  dot: { width: 4, height: 4, borderRadius: 2 },
  gapBox: { position: "absolute", borderLeftWidth: 1.5, borderRightWidth: 1.5, borderColor: "rgba(255,255,255,0.7)", borderStyle: "dashed",
    backgroundImage: "linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0.10), rgba(255,255,255,0))" },
  confirmedGap: { borderStyle: "solid", borderColor: vision.gap },
  gapLabel: { position: "absolute", minWidth: 60, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10,
    gap: 4, backgroundColor: "rgba(0,0,0,0.85)", borderWidth: 1, borderColor: "rgba(255,255,255,0.35)" },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  gapTitle: { fontFamily: font.bold, fontSize: 10, letterSpacing: 1.1, color: vision.gap },
  gapState: { fontFamily: font.semibold, fontSize: 8, letterSpacing: 0.8, color: vision.muted },
  confirmedText: { color: "#FFFFFF" },
  measurement: { position: "absolute", flexDirection: "row", alignItems: "center" },
  measureLine: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.7)" },
  measureCap: { width: 1, height: 9, backgroundColor: vision.gap },
  statusPill: { position: "absolute", right: 8, bottom: 8, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, backgroundColor: vision.surface },
  statusText: { fontFamily: font.semibold, fontSize: 10, color: vision.text },
});
