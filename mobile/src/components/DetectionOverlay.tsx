import { useMemo, useState } from "react";
import type { LayoutChangeEvent, ViewStyle } from "react-native";
import { StyleSheet, Text, View } from "react-native";

import type { DetectionBox, OnDeviceInference } from "@/api/types";
import { font, ink } from "@/config/tokens";

type Size = { width: number; height: number };

type Props = {
  result: OnDeviceInference | null;
};

function projectCoverBox(box: DetectionBox, frame: Size, viewport: Size): ViewStyle | null {
  if (frame.width <= 0 || frame.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const scale = Math.max(viewport.width / frame.width, viewport.height / frame.height);
  const offsetX = (viewport.width - frame.width * scale) / 2;
  const offsetY = (viewport.height - frame.height * scale) / 2;
  const [x1, y1, x2, y2] = box;
  const projected = {
    left: x1 * scale + offsetX,
    top: y1 * scale + offsetY,
    width: (x2 - x1) * scale,
    height: (y2 - y1) * scale,
  };
  return Object.values(projected).every(Number.isFinite) && projected.width > 0 && projected.height > 0
    ? projected
    : null;
}

function confidenceLabel(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function DetectionOverlay({ result }: Props) {
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const detections = useMemo(() => {
    if (!result) return [];
    const frame = { width: result.frameWidth, height: result.frameHeight };
    return [
      ...result.vehicles.map((vehicle, index) => ({
        key: `vehicle-${index}`,
        label: vehicle.cls,
        accessibilityLabel: `${vehicle.cls}, ${confidenceLabel(vehicle.confidence)} confidence`,
        confidence: vehicle.confidence,
        box: projectCoverBox(vehicle.bbox, frame, viewport),
        tone: "vehicle" as const,
      })),
      ...result.signs.map((sign, index) => ({
        key: `sign-${index}`,
        label: "sign",
        accessibilityLabel: `parking sign, ${confidenceLabel(sign.confidence)} confidence`,
        confidence: sign.confidence,
        box: projectCoverBox(sign.bbox, frame, viewport),
        tone: "sign" as const,
      })),
    ];
  }, [result, viewport]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) => current.width === width && current.height === height ? current : { width, height });
  };
  const vehicleCount = result?.vehicles.length ?? 0;
  const signCount = result?.signs.length ?? 0;
  const status = result == null
    ? "Waiting for detections"
    : vehicleCount + signCount === 0
      ? "No detections"
      : `${vehicleCount} vehicle${vehicleCount === 1 ? "" : "s"} · ${signCount} sign${signCount === 1 ? "" : "s"}`;

  return (
    <View testID="detection-overlay" onLayout={onLayout} style={StyleSheet.absoluteFill}>
      {detections.map((detection) => detection.box && (
        <View
          key={detection.key}
          accessible
          accessibilityLabel={detection.accessibilityLabel}
          style={[
            styles.box,
            detection.tone === "sign" ? styles.signBox : styles.vehicleBox,
            detection.box,
          ]}
        >
          <Text style={[styles.label, detection.tone === "sign" ? styles.signLabel : styles.vehicleLabel]}>
            {detection.label} {confidenceLabel(detection.confidence)}
          </Text>
        </View>
      ))}
      <View style={styles.statusPill}>
        <Text style={styles.statusText}>{status}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: "absolute", borderWidth: 2 },
  vehicleBox: { borderColor: "#35F28B" },
  signBox: { borderColor: "#FFD166" },
  label: {
    position: "absolute",
    left: -2,
    top: -18,
    paddingHorizontal: 4,
    paddingVertical: 1,
    fontFamily: font.bold,
    fontSize: 10,
    color: ink.black,
  },
  vehicleLabel: { backgroundColor: "#35F28B" },
  signLabel: { backgroundColor: "#FFD166" },
  statusPill: {
    position: "absolute",
    right: 6,
    bottom: 6,
    maxWidth: "80%",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.68)",
  },
  statusText: { fontFamily: font.semibold, fontSize: 9, color: ink.white },
});
