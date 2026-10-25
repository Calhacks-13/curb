import type { CurbVision } from "curb-vision";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Frame } from "react-native-vision-camera";
import { scheduleOnRN } from "react-native-worklets";

import { getApi } from "@/api/client";
import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { font, ink, radius, shadow } from "@/config/tokens";
import { DetectionOverlay } from "@/components/DetectionOverlay";
import { DetectionUploadController } from "@/features/capture/DetectionUploadController";
import type { FrameContext } from "@/features/capture/detectionUpload";

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

function NativeCameraOverlay({ active, sampling, frameContext, reduceMotion, onSpotConfirmed, onStartScan, onStopScan }: Props) {
  // VisionCamera 5 has no web implementation and initializes Nitro on import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Camera, useCameraPermission, useCameraDevice, useFrameOutput } = require("react-native-vision-camera") as typeof import("react-native-vision-camera");
  const { hasPermission, canRequestPermission, status, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");
  const [native, setNative] = useState<CurbVision | null>(null);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [latestInference, setLatestInference] = useState<{ session: object; result: OnDeviceInference } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const latest = useRef({ frameContext, onSpotConfirmed });
  useEffect(() => { latest.current = { frameContext, onSpotConfirmed }; }, [frameContext, onSpotConfirmed]);
  const controller = useRef<DetectionUploadController | null>(null);
  useEffect(() => {
    controller.current = new DetectionUploadController({
      context: () => latest.current.frameContext(),
      upload: (payload) => getApi().uploadDetections(payload),
      onSpotConfirmed: (result) => latest.current.onSpotConfirmed?.(result),
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
  const sessionRef = useRef<object | null>(null);
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

  if (!hasPermission) {
    const blocked = !canRequestPermission;
    return (
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
  }

  if (!device) return <CameraUnavailable />;

  const visibleInference = enabled && latestInference?.session === session ? latestInference.result : null;

  const cameraSurface = (fullScreen: boolean) => (
    <View style={fullScreen ? styles.fullScreenPreview : styles.preview}>
      <Camera
        style={StyleSheet.absoluteFill}
        isActive={active && hasPermission}
        device={device}
        outputs={outputs}
        onError={onCameraError}
        resizeMode="cover"
      />
      <DetectionOverlay result={visibleInference} />
      <View style={styles.liveTag}>
        <LiveDot on={enabled} reduceMotion={reduceMotion} />
        <Text style={styles.liveText}>{enabled ? "Live" : "Preview"}</Text>
      </View>
    </View>
  );

  return (
    <>
      <View
        style={styles.card}
        accessibilityLabel={scannerError ? `Scanner error: ${scannerError}` : enabled ? "Scanning the curb." : "Camera preview. Tap Start Scanning to begin."}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Expand live camera preview"
          onPress={() => setExpanded(true)}
          style={({ pressed }) => pressed && styles.previewPressed}
        >
          {!expanded && cameraSurface(false)}
        </Pressable>
        {scannerError && <Text accessibilityRole="alert" style={styles.sub}>{scannerError}</Text>}
        {sampling ? (
          <>
            <Text style={styles.caption}>{enabled ? "Scanning curb" : "Camera preview"}</Text>
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
      </View>

      {expanded && (
        <Modal
          visible
          animationType={reduceMotion ? "none" : "fade"}
          presentationStyle="fullScreen"
          statusBarTranslucent
          onRequestClose={() => setExpanded(false)}
        >
          <View style={styles.fullScreen}>
            {cameraSurface(true)}
            <View style={styles.fullScreenHeader}>
              <View>
                <Text style={styles.fullScreenTitle}>On-device vision</Text>
                <Text style={styles.fullScreenSubtitle}>Frames stay on this iPhone</Text>
              </View>
            </View>
            <Pressable
              onPress={() => setExpanded(false)}
              accessibilityRole="button"
              accessibilityLabel="Close full-screen camera"
              style={({ pressed }) => [styles.closeButton, pressed && { opacity: 0.72 }]}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  card: { width: 104, padding: 5, borderRadius: radius.button, backgroundColor: ink.black, ...shadow.floating },
  preview: { height: 72, borderRadius: 8, overflow: "hidden", backgroundColor: ink.grey900 },
  previewPressed: { opacity: 0.88 },
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
  startButton: { marginTop: 5, marginHorizontal: 2, height: 26, borderRadius: 13, backgroundColor: ink.live, alignItems: "center", justifyContent: "center" },
  startText: { fontFamily: font.bold, fontSize: 11, color: ink.white, marginTop: 1 },
  stopButton: { marginTop: 4, marginHorizontal: 2, height: 26, borderRadius: 13, backgroundColor: ink.grey900, alignItems: "center", justifyContent: "center" },
  stopText: { fontFamily: font.bold, fontSize: 11, color: ink.grey300, marginTop: 1 },
  fullScreen: { flex: 1, backgroundColor: ink.black },
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
