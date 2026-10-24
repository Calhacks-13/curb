import { CameraView, useCameraPermissions } from "expo-camera";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";
import { CaptureController } from "@/features/capture/CaptureController";
import { discardFrame, uploadFrame, type FrameContext } from "@/features/capture/frameUpload";

type Props = {
  /** Find is focused and the app is in the foreground. The preview unmounts otherwise. */
  active: boolean;
  /** Upload sampled frames (live backend with a location fix). Demo replay shows preview only. */
  sampling: boolean;
  /** Latest metadata for each frame (location, heading, ids). */
  frameContext: () => FrameContext | null;
  reduceMotion: boolean;
};

/** Prefer 720p; fall back to whatever the device offers. */
const PREFERRED_SIZES = ["1280x720", "Medium", "High"];

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

type LiveCameraProps = {
  sampling: boolean;
  frameContext: () => FrameContext | null;
  onFrameSent: () => void;
  onCapturing: (capturing: boolean) => void;
};

/**
 * The preview itself. Mounted only while Find is active, so camera readiness and
 * the sampler start fresh every time the screen comes back.
 */
function LiveCamera({ sampling, frameContext, onFrameSent, onCapturing }: LiveCameraProps) {
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const ctxRef = useRef(frameContext);
  useEffect(() => {
    ctxRef.current = frameContext;
  }, [frameContext]);

  const capturing = ready && sampling;
  useEffect(() => {
    onCapturing(capturing);
    if (!capturing) return;
    const controller = new CaptureController({
      capture: async () => {
        const shot = await camera.current?.takePictureAsync({ quality: 0.5, shutterSound: false });
        if (!shot?.uri) throw new Error("no frame");
        return shot.uri;
      },
      upload: async (uri) => {
        const ctx = ctxRef.current();
        if (!ctx) throw new Error("no location yet");
        await uploadFrame(uri, ctx);
        onFrameSent();
      },
      discard: discardFrame,
    });
    controller.start();
    return () => {
      controller.stop();
      onCapturing(false);
    };
  }, [capturing, onCapturing, onFrameSent]);

  const onReady = async () => {
    setReady(true);
    try {
      const sizes = (await camera.current?.getAvailablePictureSizesAsync()) ?? [];
      setPictureSize(PREFERRED_SIZES.find((sz) => sizes.includes(sz)));
    } catch {
      // Keep the default size.
    }
  };

  return (
    <CameraView
      ref={camera}
      style={StyleSheet.absoluteFill}
      facing="back"
      animateShutter={false}
      pictureSize={pictureSize}
      onCameraReady={onReady}
    />
  );
}

/** Floating live camera card on Find: preview, scanning indicator, frame sampling. */
export function CameraOverlay({ active, sampling, frameContext, reduceMotion }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [sent, setSent] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const onFrameSent = useCallback(() => setSent((n) => n + 1), []);

  // Ask once when Find first needs the camera.
  useEffect(() => {
    if (active && permission && !permission.granted && permission.canAskAgain && permission.status === "undetermined") requestPermission();
  }, [active, permission, requestPermission]);

  const granted = !!permission?.granted;
  const live = active && capturing;

  if (!granted) {
    const blocked = permission && !permission.canAskAgain;
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

  return (
    <View
      style={styles.card}
      accessible
      accessibilityLabel={sampling ? `Scanning the curb. ${sent} frames shared.` : "Camera preview. Demo replay, not uploading."}
    >
      <View style={styles.preview}>
        {active && <LiveCamera sampling={sampling} frameContext={frameContext} onFrameSent={onFrameSent} onCapturing={setCapturing} />}
        <View style={styles.liveTag}>
          <LiveDot on={live} reduceMotion={reduceMotion} />
          <Text style={styles.liveText}>{live ? "Live" : "Preview"}</Text>
        </View>
      </View>
      <Text style={styles.caption}>{sampling ? "Scanning curb" : "Camera on"}</Text>
      <Text style={styles.sub}>{sampling ? `${sent} frames shared` : "Not uploading"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: 104, padding: 5, borderRadius: radius.button, backgroundColor: ink.black, ...shadow.floating },
  preview: { height: 72, borderRadius: 8, overflow: "hidden", backgroundColor: ink.grey900 },
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
});
