import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AccountButton } from "@/components/AccountButton";
import { CurbMap } from "@/components/map/CurbMap";
import { MapLegend } from "@/components/MapLegend";
import { MoodToggle } from "@/components/MoodToggle";
import { NearbySheet } from "@/components/NearbySheet";
import { SharingLivePip } from "@/components/SharingLivePip";
import { font, ink, radius } from "@/config/tokens";
import { DEMO_DRIVER } from "@/data/mock/marina";
import { DemoModeBadge } from "@/demo/DemoModeBadge";
import { findOptions, mapPills, mapSignature, mapStalls, mapZones, type FindOption } from "@/features/find/options";
import { useFreshnessClock } from "@/features/find/useFreshnessClock";
import { useParkingState } from "@/features/find/useParkingState";
import { useMood } from "@/hooks/useMood";
import { useReduceMotion } from "@/hooks/useReduceMotion";
import { HOME_CAMERA, SPOT_CAMERA } from "@/map/mapConfig";
import type { MapController, MapToApp } from "@/map/messages";

const SHARED_SPOTS = 3;

export default function FindScreen() {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const { setting, setSetting, mood } = useMood();
  const mapRef = useRef<MapController>(null);
  const send: MapController["send"] = useCallback((m) => mapRef.current?.send(m), []);

  // Demo replay centers on the calibrated block; live mode will use device location.
  const driver = DEMO_DRIVER;
  const { state, load, refresh, mode } = useParkingState(HOME_CAMERA.center);
  const now = useFreshnessClock();
  const options = useMemo(() => findOptions(state, now, driver.position), [state, now, driver.position]);
  const signature = mapSignature(options);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  // --- push state to the map (only when what's drawn changes) ---------------

  useEffect(() => {
    send({ type: "setZones", zones: mapZones(state.zones) });
  }, [state.zones, send]);

  useEffect(() => {
    send({ type: "setStalls", stalls: mapStalls(options) });
    send({ type: "setPills", pills: mapPills(options) });
    // `options` changes every tick; the signature only when a bay appears, ages or goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, send]);

  useEffect(() => {
    send({ type: "setCarPosition", position: driver.position, heading: driver.heading });
  }, [driver, send]);

  // A selected opening that expired or was taken is no longer selectable.
  useEffect(() => {
    if (selectedId && !options.some((o) => o.id === selectedId)) setSelectedId(null);
  }, [options, selectedId]);

  useEffect(() => {
    send({ type: "selectSpot", id: selectedId });
  }, [selectedId, send]);

  const [sheetH, setSheetH] = useState(260);
  const padding = useMemo(() => ({ top: insets.top + 70, bottom: sheetH + 12, left: 0, right: 0 }), [insets.top, sheetH]);
  useEffect(() => {
    send({ type: "setPadding", padding });
  }, [padding, send]);

  // --- interactions ---------------------------------------------------------

  const select = useCallback(
    (o: FindOption) => {
      setSelectedId(o.id);
      send({
        type: "flyTo",
        camera: { center: o.position, zoom: SPOT_CAMERA.zoom, pitch: SPOT_CAMERA.pitch, padding, durationMs: SPOT_CAMERA.durationMs },
      });
    },
    [padding, send],
  );

  const onMapMessage = useCallback(
    (msg: MapToApp) => {
      if (msg.type === "mapError") setMapError(msg.message);
      if (msg.type === "mapReady") setMapError(null);
      if (msg.type === "spotTapped") {
        const o = options.find((x) => x.id === msg.id);
        if (o) select(o);
      }
    },
    [options, select],
  );

  return (
    <View style={styles.root}>
      <StatusBar style={mood === "clay" ? "dark" : "light"} />
      <CurbMap ref={mapRef} mood={mood} reduceMotion={reduceMotion} onMapMessage={onMapMessage} />

      <View style={[styles.top, { top: insets.top + 8 }]}>
        <View style={styles.leftCol}>
          {mode === "demo" && <DemoModeBadge />}
          <SharingLivePip spotsShared={SHARED_SPOTS} reduceMotion={reduceMotion} />
        </View>
        <View style={styles.mapButtons}>
          <AccountButton />
          <MoodToggle value={setting} onChange={setSetting} />
          <MapLegend />
        </View>
      </View>

      <NearbySheet
        options={options}
        load={load}
        selectedId={selectedId}
        onSelect={select}
        onRetry={refresh}
        bottomInset={insets.bottom}
        onContentHeight={setSheetH}
      />

      {mapError && (
        <View style={[styles.error, { top: insets.top + 140 }]} accessibilityLiveRegion="polite">
          <Text style={styles.errorText}>Map: {mapError}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  leftCol: { gap: 10, alignItems: "flex-start" },
  mapButtons: { gap: 10, alignItems: "flex-end" },
  error: {
    position: "absolute",
    left: 16,
    right: 16,
    backgroundColor: ink.black,
    borderRadius: radius.button,
    padding: 12,
  },
  errorText: { color: ink.white, fontFamily: font.regular, fontSize: 13 },
});
