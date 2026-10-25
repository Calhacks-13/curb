import type { CurbVision } from "curb-vision";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Frame } from "react-native-vision-camera";
import { scheduleOnRN } from "react-native-worklets";

import { getApi } from "@/api/client";
import type { FrameAccepted, OnDeviceInference, SignFeedback } from "@/api/types";
import { font, ink, radius, shadow } from "@/config/tokens";
import { DetectionOverlay } from "@/components/DetectionOverlay";
import { ScannerDetails } from "@/components/ScannerDetails";
import { DetectionUploadController, type DeepReadonly, type DetectionDeliveryEvent } from "@/features/capture/DetectionUploadController";
import type { FrameContext } from "@/features/capture/detectionUpload";
import { useNow } from "@/hooks/useNow";

type Props = {
  /** Find is focused and the app is in the foreground. */
  active: boolean;
  /** Run inference and upload detections. Demo replay shows preview only. */
  sampling: boolean;
  /** Latest metadata for each frame (location, heading, ids). */
  frameContext: () => FrameContext | null;
  reduceMotion: boolean;
  /** Called when the server confirms a spot from a scanned frame. */
  onSpotConfirmed?: (result: FrameAccepted) => void;
  /** Called when the user taps "Start Scanning" to begin inference. */
  onStartScan?: () => void;
  /** Called when the user taps "Stop" to end inference. */
  onStopScan?: () => void;
  /** Expands the existing draggable host without replacing the native camera. */
  onExpandedChange?: (expanded: boolean) => void;
};

const FRAME_RESOLUTION = { width: 1280, height: 720 };

function LiveDot({ on, reduceMotion }: { on: boolean; reduceMotion: boolean }) {
  const [blink] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!on || reduceMotion) {
      blink.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink, on, reduceMotion]);
  return <Animated.View style={[styles.dot, { opacity: blink, backgroundColor: on ? ink.live : ink.grey500 }]} />;
}

function CameraUnavailable() {
  return (
    <View style={styles.card}>
      <View style={[styles.preview, styles.previewEmpty]}>
        <SymbolView name="video.slash.fill" size={16} tintColor={ink.grey500} fallback={null} />
      </View>
      <Text style={styles.caption}>Camera unavailable</Text>
    </View>
  );
}

/** Web has no native preview; do not load VisionCamera or CoreML there. */
export function CameraOverlay(props: Props) {
  return Platform.OS === "web" ? <CameraUnavailable /> : <NativeCameraOverlay {...props} />;
}

function NativeCameraOverlay({ active, sampling, frameContext, reduceMotion, onSpotConfirmed, onStartScan, onStopScan, onExpandedChange }: Props) {
  // VisionCamera 5 has no web implementation and initializes Nitro on import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Camera, useCameraPermission, useCameraDevice, useFrameOutput } = require("react-native-vision-camera") as typeof import("react-native-vision-camera");
  const { hasPermission, canRequestPermission, status, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");
  const [native, setNative] = useState<CurbVision | null>(null);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [latestInference, setLatestInference] = useState<{ session: object; result: OnDeviceInference } | null>(null);
  const [latestDelivery, setLatestDelivery] = useState<{ session: object; event: DetectionDeliveryEvent } | null>(null);
  const [lastSigns, setLastSigns] = useState<{ session: object; signs: DeepReadonly<SignFeedback[]> } | null>(null);
  const now = useNow(500);
  const [expanded, setExpanded] = useState(false);
  const changeExpanded = useCallback((next: boolean) => {
    setExpanded(next);
    onExpandedChange?.(next);
  }, [onExpandedChange]);
  const latest = useRef({ frameContext, onSpotConfirmed });
  const sessionRef = useRef<object | null>(null);
  useEffect(() => { latest.current = { frameContext, onSpotConfirmed }; }, [frameContext, onSpotConfirmed]);
  const controller = useRef<DetectionUploadController | null>(null);
  useEffect(() => {
    controller.current = new DetectionUploadController({
      context: () => latest.current.frameContext(),
      upload: (payload) => getApi().uploadDetections(payload),
      onSpotConfirmed: (result) => latest.current.onSpotConfirmed?.(result),
      onDelivery: (event) => {
        const current = sessionRef.current;
        if (current) setLatestDelivery({ session: current, event });
        if (current && event.state === "delivered") {
          const readings = event.result.sign_feedback?.filter((sign) => sign.reading != null);
          if (readings?.length) setLastSigns({ session: current, signs: readings });
        }
      },
    });
    return () => { controller.current?.stop(); controller.current = null; };
  }, []);
  const eligible = active && sampling && Platform.OS === "ios" && hasPermission && device != null && getApi().mode === "live";

  useEffect(() => {
    if (!eligible || native || scannerError) return;
    let cancelled = false;
    // Never import or instantiate the iOS-only HybridObject on Android/web.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCurbVision } = require("curb-vision") as typeof import("curb-vision");
      setNative(getCurbVision());
    }).catch((error: unknown) => {
      if (!cancelled) setScannerError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [eligible, native, scannerError]);

  const enabled = eligible && native != null && scannerError == null;
  // RN callbacks retain session identity; delayed worklet deliveries from a
  // previous Stop/blur can never become uploads in a later scanning session.
  const session = useMemo(() => ({ enabled }), [enabled]);
  useEffect(() => {
    if (enabled) {
      sessionRef.current = session;
      controller.current?.start();
    } else {
      sessionRef.current = null;
      controller.current?.stop();
    }
    return () => {
      sessionRef.current = null;
      controller.current?.stop();
    };
  }, [enabled, session]);

  const onInference = useCallback((result: OnDeviceInference) => {
    if (sessionRef.current === session) {
      setLatestInference({ session, result });
      controller.current?.submit(result);
    }
  }, [session]);
  const failScanner = useCallback((message: string) => {
    sessionRef.current = null;
    controller.current?.stop();
    setScannerError(message);
  }, []);
  const onInferenceError = useCallback((message: string) => {
    if (sessionRef.current === session) failScanner(message);
  }, [failScanner, session]);
  const onCameraError = useCallback((error: Error) => failScanner(error.message), [failScanner]);
  const onFrame = useCallback((frame: Frame) => {
    "worklet";
    try {
      if (enabled && native) {
        const result = native.detect(frame);
        scheduleOnRN(onInference, result);
      }
    } catch (error) {
      scheduleOnRN(onInferenceError, error instanceof Error ? error.message : String(error));
    } finally {
      frame.dispose();
    }
  }, [enabled, native, onInference, onInferenceError]);
  const frameOutput = useFrameOutput({
    targetResolution: FRAME_RESOLUTION,
    pixelFormat: "native",
    enablePhysicalBufferRotation: true,
    dropFramesWhileBusy: true,
    onFrame,
  });
  const outputs = useMemo(() => enabled ? [frameOutput] : [], [enabled, frameOutput]);

  // Ask once when Find first needs the camera.
  useEffect(() => {
    if (active && !hasPermission && canRequestPermission && status === "not-determined") void requestPermission();
  }, [active, hasPermission, canRequestPermission, status, requestPermission]);

  const fullScreenCloseButton = (
    <Pressable
      onPress={() => changeExpanded(false)}
      accessibilityRole="button"
      accessibilityLabel="Close full-screen camera"
      style={({ pressed }) => [styles.closeButton, pressed && { opacity: 0.72 }]}
    >
      <Text style={styles.closeText}>×</Text>
    </Pressable>
  );

  if (!hasPermission) {
    const blocked = !canRequestPermission;
    const permissionCard = (
      <Pressable
        onPress={() => (blocked ? Linking.openSettings() : requestPermission())}
        accessibilityRole="button"
        accessibilityLabel={blocked ? "Camera is off. Open Settings to share curb sightings." : "Turn on the camera to share curb sightings."}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      >
        <View style={[styles.preview, styles.previewEmpty]}>
          <SymbolView name="video.slash.fill" size={16} tintColor={ink.grey500} fallback={null} />
        </View>
        <Text style={styles.caption}>{blocked ? "Camera off" : "Turn on camera"}</Text>
        <Text style={styles.sub}>{blocked ? "Open Settings" : "Share open spots"}</Text>
      </Pressable>
    );
    return expanded ? (
      <View style={styles.fullScreen}>
        <View style={styles.fallbackCenter}>{permissionCard}</View>
        {fullScreenCloseButton}
      </View>
    ) : permissionCard;
  }

  if (!device) {
    return expanded ? (
      <View style={styles.fullScreen}>
        <View style={styles.fallbackCenter}><CameraUnavailable /></View>
        {fullScreenCloseButton}
      </View>
    ) : <CameraUnavailable />;
  }

  const visibleInference = enabled && latestInference?.session === session ? latestInference.result : null;
  const delivery = enabled && latestDelivery?.session === session ? latestDelivery.event : null;
  const receipt = delivery?.state === "delivered" ? delivery.result : null;
  // Server geometry belongs to the submitted sample, not subsequent native frames.
  // Hide delayed results and geometry from a different camera orientation.
  const freshAnalysis = !!receipt?.captured_at && now.getTime() - Date.parse(receipt.captured_at) < 3000;
  const alignedAnalysis = freshAnalysis && visibleInference?.frameWidth === receipt?.frame_width && visibleInference?.frameHeight === receipt?.frame_height;
  const count = (value: number | undefined, noun: string) => value == null ? null : `${value} ${noun}${value === 1 ? "" : "s"}`;
  const receiptText = ["Server received", count(receipt?.vehicle_count, "vehicle"), count(receipt?.gap_count, "gap")].filter(Boolean).join(" · ");
  const deliveryText = delivery?.state === "failed" ? "Upload unavailable"
    : receipt ? receiptText
      : visibleInference ? "Waiting for server receipt" : "Waiting for first inference";
  const deliveryDetail = delivery?.state === "failed" ? delivery.error.message
    : receipt ? [receipt.pipeline_state, receipt.scene_valid == null ? null : receipt.scene_valid ? "Scene valid" : "No valid scene"].filter(Boolean).join(" · ") : "";
  const badge = !enabled ? "Preview" : delivery?.state === "failed" ? "Retrying" : receipt ? "Connected" : visibleInference ? "Sending" : "Starting";
  const deliveryStatus = enabled && (
    <View style={expanded ? styles.fullScreenDelivery : styles.delivery}>
      <Text style={styles.deliveryText}>{deliveryText}</Text>
      {!!deliveryDetail && <Text style={styles.deliveryDetail}>{deliveryDetail}</Text>}
    </View>
  );

  const cameraSurface = (
    <View style={expanded ? styles.fullScreenPreview : styles.preview}>
      <Camera
        style={StyleSheet.absoluteFill}
        isActive={active && hasPermission}
        device={device}
        outputs={outputs}
        onError={onCameraError}
        resizeMode="cover"
      />
      <DetectionOverlay result={visibleInference} analysis={alignedAnalysis ? receipt : null} />
      <View style={styles.liveTag}>
        <LiveDot on={enabled && delivery?.state !== "failed"} reduceMotion={reduceMotion} />
        <Text style={styles.liveText}>{badge}</Text>
      </View>
      {!expanded && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Expand live camera preview"
          onPress={() => changeExpanded(true)}
          style={({ pressed }) => [styles.expandHitTarget, pressed && styles.previewPressed]}
        />
      )}
    </View>
  );

  return (
    <View
      style={expanded ? styles.fullScreen : styles.card}
      accessibilityLabel={scannerError ? `Scanner error: ${scannerError}` : enabled ? `Scanning the curb. ${deliveryText}. ${deliveryDetail}` : "Camera preview. Tap Start Scanning to begin."}
    >
      {cameraSurface}
      {expanded ? (
        <>
          <View style={styles.fullScreenHeader}>
            <View>
              <Text style={styles.fullScreenTitle}>On-device vision</Text>
              <Text style={styles.fullScreenSubtitle}>Frames stay on this iPhone</Text>
            </View>
          </View>
          {deliveryStatus}
          {enabled && <ScannerDetails
            analysis={receipt}
            lastSigns={lastSigns?.session === session ? lastSigns.signs : []}
            signCount={visibleInference?.signs.length ?? 0}
            fresh={!!alignedAnalysis}
          />}
          {scannerError && (
            <View style={styles.fullScreenError}>
              <Text style={styles.errorTitle}>Scanner stopped</Text>
              <Text accessibilityRole="alert" style={styles.errorMessage}>{scannerError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => { changeExpanded(false); onStopScan?.(); }}
                style={({ pressed }) => [styles.errorButton, pressed && { opacity: 0.8 }]}
              >
                <Text style={styles.errorButtonText}>Close and stop scanning</Text>
              </Pressable>
            </View>
          )}
          {fullScreenCloseButton}
        </>
      ) : (
        <>
        {deliveryStatus}
        {enabled && <Text style={styles.sub}>Expand for gaps + sign text</Text>}
        {scannerError && <Text accessibilityRole="alert" style={styles.sub}>{scannerError}</Text>}
        {sampling ? (
          <>
            <Text style={styles.caption}>{enabled ? delivery?.state === "failed" ? "Retrying upload" : "Scanning curb" : "Camera preview"}</Text>
            <Pressable
              onPress={onStopScan}
              accessibilityRole="button"
              style={({ pressed }) => [styles.stopButton, pressed && { opacity: 0.8 }]}
            >
              <Text style={styles.stopText}>Stop</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={() => { setScannerError(null); onStartScan?.(); }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.startButton, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.startText}>Start Scanning</Text>
          </Pressable>
        )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: 104, padding: 5, borderRadius: radius.button, backgroundColor: ink.black, ...shadow.floating },
  preview: { height: 72, borderRadius: 8, overflow: "hidden", backgroundColor: ink.grey900 },
  previewPressed: { opacity: 0.88 },
  expandHitTarget: { ...StyleSheet.absoluteFill },
  previewEmpty: { alignItems: "center", justifyContent: "center" },
  liveTag: {
    position: "absolute",
    top: 5,
    left: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontFamily: font.bold, fontSize: 10, color: ink.white, marginTop: 2 },
  caption: { fontFamily: font.semibold, fontSize: 12, color: ink.white, marginTop: 5, marginLeft: 2 },
  sub: { fontFamily: font.regular, fontSize: 11, color: ink.grey300, marginLeft: 2, marginBottom: 1 },
  delivery: { marginTop: 5, marginHorizontal: 2 },
  fullScreenDelivery: { position: "absolute", left: 18, right: 18, bottom: 48, padding: 12, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.78)" },
  deliveryText: { fontFamily: font.semibold, fontSize: 11, color: ink.white },
  deliveryDetail: { marginTop: 3, fontFamily: font.regular, fontSize: 10, color: ink.grey300 },
  startButton: { marginTop: 5, marginHorizontal: 2, height: 26, borderRadius: 13, backgroundColor: ink.live, alignItems: "center", justifyContent: "center" },
  startText: { fontFamily: font.bold, fontSize: 11, color: ink.white, marginTop: 1 },
  stopButton: { marginTop: 4, marginHorizontal: 2, height: 26, borderRadius: 13, backgroundColor: ink.grey900, alignItems: "center", justifyContent: "center" },
  stopText: { fontFamily: font.bold, fontSize: 11, color: ink.grey300, marginTop: 1 },
  fullScreen: { flex: 1, backgroundColor: ink.black },
  fallbackCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  fullScreenPreview: { ...StyleSheet.absoluteFill, overflow: "hidden", backgroundColor: ink.black },
  fullScreenHeader: {
    position: "absolute",
    top: 56,
    left: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.68)",
  },
  fullScreenTitle: { fontFamily: font.bold, fontSize: 16, color: ink.white },
  fullScreenSubtitle: { marginTop: 2, fontFamily: font.regular, fontSize: 11, color: ink.grey300 },
  fullScreenError: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 48,
    padding: 16,
    borderRadius: 16,
    backgroundColor: "rgba(11,11,12,0.9)",
  },
  errorTitle: { fontFamily: font.bold, fontSize: 18, color: ink.white },
  errorMessage: { marginTop: 6, fontFamily: font.regular, fontSize: 13, color: ink.grey300 },
  errorButton: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ink.live,
  },
  errorButtonText: { fontFamily: font.bold, fontSize: 13, color: ink.white },
  closeButton: {
    position: "absolute",
    top: 56,
    right: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  closeText: { marginTop: -3, fontFamily: font.regular, fontSize: 34, lineHeight: 38, color: ink.white },
});
