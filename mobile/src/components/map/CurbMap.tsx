import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { AppToMap, MapController, MapToApp } from "@/map/messages";
import { MOODS, type Mood } from "@/map/moods";
import { buildMapHtml } from "@/map/webview/mapHtml";

type Props = {
  mood: Mood;
  reduceMotion: boolean;
  onMapMessage?: (message: MapToApp) => void;
};

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "";

/**
 * Full-screen map. Today this is Mapbox GL JS in a WebView; anything that
 * implements MapController with the same messages can replace it.
 */
export const CurbMap = forwardRef<MapController, Props>(function CurbMap(
  { mood, reduceMotion, onMapMessage },
  ref,
) {
  // The package types default WebView<P> to `undefined`, which TS 6 collapses to never.
  const webRef = useRef<WebView<object>>(null);
  const ready = useRef(false);
  const pending = useRef<AppToMap[]>([]);

  // Build the page once; later changes go over the bridge so the map never reloads.
  const initial = useRef({ mood, reduceMotion });
  const html = useMemo(() => buildMapHtml({ token: TOKEN, ...initial.current }), []);

  const inject = useCallback((message: AppToMap) => {
    const json = JSON.stringify(message).replace(/</g, "\\u003c");
    webRef.current?.injectJavaScript(`window.__curb&&window.__curb.receive(${json});true;`);
  }, []);

  const send = useCallback(
    (message: AppToMap) => {
      if (ready.current) inject(message);
      else pending.current.push(message);
    },
    [inject],
  );

  useImperativeHandle(ref, () => ({ send }), [send]);

  const lastMood = useRef(mood);
  useEffect(() => {
    if (lastMood.current === mood) return;
    lastMood.current = mood;
    send({ type: "setMood", mood, animate: true });
  }, [mood, send]);

  useEffect(() => {
    send({ type: "setReduceMotion", reduceMotion });
  }, [reduceMotion, send]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: MapToApp;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === "mapReady") {
        ready.current = true;
        pending.current.splice(0).forEach(inject);
      }
      if (msg.type === "mapError" && __DEV__) console.warn("[map]", msg.message);
      onMapMessage?.(msg);
    },
    [inject, onMapMessage],
  );

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: MOODS[mood].background }]}>
      <WebView<object>
        ref={webRef}
        source={{ html }}
        originWhitelist={["*"]}
        onMessage={onMessage}
        style={styles.web}
        containerStyle={styles.web}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
});
