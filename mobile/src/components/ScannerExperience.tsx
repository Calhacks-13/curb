import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { font } from "@/config/tokens";
import { vision } from "@/config/vision";
import type { ScannerPresentation, ScannerSign } from "@/features/capture/scannerPresentation";

type Props = {
  presentation: ScannerPresentation;
  sign: ScannerSign | null;
  previousSign: boolean;
  sampling: boolean;
  diagnostics: boolean;
  reduceMotion: boolean;
  error: string | null;
  onToggleDiagnostics: () => void;
  onPause: () => void;
  onStart: () => void;
  onCloseError: () => void;
};

/** Compact demo controls: the camera and detection geometry carry the story. */
export function ScannerExperience({ presentation, sign, previousSign, sampling, diagnostics, reduceMotion, error,
  onToggleDiagnostics, onPause, onStart, onCloseError }: Props) {
  const [showPrevious, setShowPrevious] = useState(false);
  const [showText, setShowText] = useState(false);
  const [opacity] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  useEffect(() => {
    if (reduceMotion) { opacity.setValue(1); return; }
    const animation = Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [opacity, reduceMotion]);
  const reading = sign?.reading;
  const observations = [[presentation.vehicleCount, "car"], [presentation.candidateCount, "opening"], [presentation.signCount, "sign"]] as const;
  const counts = observations.map(([value, noun]) => `${value} ${noun}${value === 1 ? "" : "s"}`).join(" · ");
  const showReading = !!reading && (!previousSign || showPrevious);
  return <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity }]}>
    <View pointerEvents="none" style={styles.topScrim} /><View pointerEvents="none" style={styles.bottomScrim} />
    <View pointerEvents="none" style={styles.header}>
      <Text style={styles.wordmark}>curb</Text>
      <Text style={styles.eyebrow}>Parking preview</Text>
    </View>
    <View style={styles.bottom}>
      {error && <View style={styles.notice}><Text style={styles.errorTitle}>Scanner stopped</Text><Text accessibilityRole="alert" style={styles.noticeText}>{error}</Text></View>}
      {!diagnostics && !error && presentation.tone === "attention" && <View style={styles.notice}>
        <Text style={styles.noticeText}>{presentation.detail}</Text>
      </View>}
      {!diagnostics && !error && reading && previousSign && !showPrevious && <Pressable accessibilityRole="button" accessibilityLabel="View last parking sign"
        onPress={() => setShowPrevious(true)} style={styles.notice}><Text style={styles.previousText}>View last parking sign ↗</Text></Pressable>}
      {!diagnostics && !error && reading && showReading && <View style={styles.signStrip}>
        <Text style={styles.signEyebrow}>{previousSign ? "LAST PARKING SIGN" : "SIGN READ"}</Text>
        {previousSign && <Text style={styles.noticeText}>From an earlier observation</Text>}
        <Text style={styles.signSummary}>{reading.combined_summary}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={showText ? "Hide sign text" : "Read full sign text"} onPress={() => setShowText(!showText)}>
          <Text style={styles.previousText}>{showText ? "Hide sign text −" : "Read sign text +"}</Text>
        </Pressable>
        {showText && <Text selectable style={styles.signSummary}>{reading.signs.map((item) => item.raw_text).filter(Boolean).join("\n")}</Text>}
      </View>}
      <View style={styles.controls}>
        <Pressable accessibilityRole="button" accessibilityLabel={error ? "Close and stop scanning" : sampling ? "Pause scanning" : "Start Scanning"}
          onPress={error ? onCloseError : sampling ? onPause : onStart}
          style={({ pressed }) => [styles.mainButton, pressed && styles.pressed]}>
          <SymbolView name={sampling && !error ? "pause.fill" : "viewfinder"} size={14} tintColor="#153B2A" fallback={null} />
          <Text style={styles.mainButtonText}>{error ? "Close and stop scanning" : sampling ? "Pause" : "Start"}</Text>
        </Pressable>
        <View style={styles.runStatus}>
          <Text style={styles.runStatusText}>{presentation.badge}</Text>
          <Text style={styles.counts}>{counts}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={diagnostics ? "Hide diagnostics" : "Show diagnostics"}
          accessibilityState={{ selected: diagnostics }} onPress={onToggleDiagnostics}
          style={({ pressed }) => [styles.diagnosticsButton, diagnostics && styles.diagnosticsSelected, pressed && styles.pressed]}>
          <SymbolView name="slider.horizontal.3" size={19} tintColor={vision.text} fallback={<Text style={styles.fallbackIcon}>≡</Text>} />
        </Pressable>
      </View>
    </View>
  </Animated.View>;
}

const styles = StyleSheet.create({
  counts: { fontFamily: font.regular, fontSize: 10, color: "#ADB7AF", marginTop: 4 },
  topScrim: { position: "absolute", top: 0, left: 0, right: 0, height: 190,
    backgroundImage: "linear-gradient(to bottom, rgba(6,18,15,0.88), rgba(6,18,15,0))" },
  bottomScrim: { position: "absolute", bottom: 0, left: 0, right: 0, height: 310,
    backgroundImage: "linear-gradient(to top, rgba(6,18,15,0.8), rgba(6,18,15,0))" },
  header: { position: "absolute", top: 58, left: 24, gap: 5 },
  wordmark: { fontFamily: font.extrabold, fontSize: 28, lineHeight: 31, letterSpacing: -1.4, color: vision.text },
  eyebrow: { fontFamily: font.regular, fontSize: 12, color: "#D6DFD8" },
  bottom: { position: "absolute", bottom: 20, left: 14, right: 14, gap: 10 },
  controls: { flexDirection: "row", alignItems: "center", gap: 14, padding: 10, borderRadius: 25,
    backgroundColor: "rgba(15,20,18,0.88)" },
  mainButton: { minHeight: 44, paddingHorizontal: 19, borderRadius: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: "#E9F1E5" },
  mainButtonText: { fontFamily: font.bold, fontSize: 12, color: "#153B2A" },
  runStatus: { flex: 1, alignItems: "flex-start", justifyContent: "center" },
  runStatusText: { fontFamily: font.semibold, fontSize: 13, color: "#F6F8F4" },
  diagnosticsButton: { width: 44, height: 44, borderRadius: 18, borderWidth: 1, borderColor: vision.border, alignItems: "center", justifyContent: "center" },
  diagnosticsSelected: { backgroundColor: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.5)" },
  fallbackIcon: { color: vision.text },
  notice: { padding: 13, borderRadius: 15, borderWidth: 1, borderColor: vision.border, backgroundColor: vision.surface },
  noticeText: { fontFamily: font.regular, fontSize: 12, lineHeight: 18, color: vision.muted },
  errorTitle: { fontFamily: font.bold, fontSize: 14, color: vision.sign, marginBottom: 4 },
  previousText: { fontFamily: font.semibold, fontSize: 11, color: vision.sign },
  signStrip: { padding: 15, borderRadius: 17, backgroundColor: vision.surface, borderWidth: 1, borderColor: "rgba(244,211,154,0.25)", gap: 8 },
  signEyebrow: { fontFamily: font.bold, fontSize: 10, color: "#D8E3D9", letterSpacing: 0.5 },
  signSummary: { fontFamily: font.semibold, fontSize: 13, lineHeight: 19, color: vision.text },
  pressed: { opacity: 0.72 },
});
