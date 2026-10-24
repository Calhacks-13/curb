import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AccountButton } from "@/components/AccountButton";
import { CurbMap } from "@/components/map/CurbMap";
import { MapLegend } from "@/components/MapLegend";
import { MoodToggle } from "@/components/MoodToggle";
import { NearbyList } from "@/components/find/NearbyList";
import { RouteCard } from "@/components/find/RouteCard";
import { RouteReplacementPrompt } from "@/components/find/RouteReplacementPrompt";
import { SpaceDetailSheet } from "@/components/find/SpaceDetailSheet";
import { SheetFrame } from "@/components/sheet/SheetFrame";
import { SharingLivePip } from "@/components/SharingLivePip";
import { font, ink, radius } from "@/config/tokens";
import { DEMO_DRIVER } from "@/data/mock/marina";
import { DemoModeBadge } from "@/demo/DemoModeBadge";
import { ageSeconds } from "@/features/find/freshness";
import { findOptions, mapPills, mapSignature, mapStalls, mapZones, type FindOption } from "@/features/find/options";
import { replacementFor, requestRoute, type Route } from "@/features/find/route";
import { useFreshnessClock } from "@/features/find/useFreshnessClock";
import { useParkingState } from "@/features/find/useParkingState";
import { useSpaceDetail } from "@/features/find/useSpaceDetail";
import { useMood } from "@/hooks/useMood";
import { useReduceMotion } from "@/hooks/useReduceMotion";
import { HOME_CAMERA, SPOT_CAMERA } from "@/map/mapConfig";
import type { LngLat, MapController, MapToApp } from "@/map/messages";

const SHARED_SPOTS = 3;

type Sheet =
  | { mode: "list" }
  | { mode: "detail"; id: string }
  | { mode: "route"; id: string; title: string; position: LngLat; route: Route };

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

  const [sheet, setSheet] = useState<Sheet>({ mode: "list" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [keptRoutes, setKeptRoutes] = useState<Record<string, true>>({});

  const detailId = sheet.mode === "detail" && state.spaces[sheet.id] ? sheet.id : null;
  const detail = useSpaceDetail(detailId);
  const optionById = (id: string) => options.find((o) => o.id === id) ?? null;
  const spaceAge = (id: string) => ageSeconds(state.spaces[id]?.last_observed_at ?? null, now);

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

  // A browsed opening that expired or was taken closes its details. While routing,
  // the replacement prompt handles it instead, so the route never changes silently.
  useEffect(() => {
    if (sheet.mode === "detail" && !options.some((o) => o.id === sheet.id)) {
      setSheet({ mode: "list" });
      setSelectedId(null);
    }
  }, [options, sheet]);

  useEffect(() => {
    send({ type: "selectSpot", id: selectedId });
  }, [selectedId, send]);

  const [sheetH, setSheetH] = useState(260);
  const padding = useMemo(() => ({ top: insets.top + 70, bottom: sheetH + 12, left: 0, right: 0 }), [insets.top, sheetH]);
  useEffect(() => {
    send({ type: "setPadding", padding });
  }, [padding, send]);

  // --- interactions ---------------------------------------------------------

  /** Marker or row tap: select, frame, and open details. Never routes by itself. */
  const open = useCallback(
    (o: FindOption) => {
      setSelectedId(o.id);
      setRouteError(null);
      if (sheet.mode !== "route") setSheet(o.kind === "driveway" ? { mode: "list" } : { mode: "detail", id: o.id });
      send({
        type: "flyTo",
        camera: { center: o.position, zoom: SPOT_CAMERA.zoom, pitch: SPOT_CAMERA.pitch, padding, durationMs: SPOT_CAMERA.durationMs },
      });
    },
    [padding, send, sheet.mode],
  );

  const routeTo = useCallback(
    async (o: FindOption) => {
      setRouting(true);
      setRouteError(null);
      try {
        const route = await requestRoute(driver.position, o.position);
        setSelectedId(o.id);
        setSheet({ mode: "route", id: o.id, title: o.title, position: o.position, route });
        send({ type: "setRoute", route: route.line, targetId: o.id, fit: true });
      } catch {
        setRouteError("Couldn't get a route. Check your connection and try again.");
      } finally {
        setRouting(false);
      }
    },
    [driver.position, send],
  );

  const closeSheet = useCallback(() => {
    setSheet({ mode: "list" });
    setSelectedId(null);
    setRouteError(null);
    send({ type: "setRoute", route: null, targetId: null });
  }, [send]);

  // Taken or stale while routing: offer a replacement, but only change on confirm.
  const replacement =
    sheet.mode === "route" && !keptRoutes[sheet.id] && optionById(sheet.id)?.kind !== "driveway"
      ? replacementFor(sheet.id, sheet.position, options)
      : null;
  const keepRoute = () => sheet.mode === "route" && setKeptRoutes((k) => ({ ...k, [sheet.id]: true }));
  const acceptReplacement = () => {
    if (replacement?.alternative) routeTo(replacement.alternative);
  };

  const onMapMessage = useCallback(
    (msg: MapToApp) => {
      if (msg.type === "mapError") setMapError(msg.message);
      if (msg.type === "mapReady") setMapError(null);
      if (msg.type === "spotTapped") {
        const o = options.find((x) => x.id === msg.id);
        if (o) open(o);
      }
    },
    [options, open],
  );

  const detailOption = sheet.mode === "detail" ? optionById(sheet.id) : null;

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

      <SheetFrame bottomInset={insets.bottom} onContentHeight={setSheetH}>
        {sheet.mode === "list" && <NearbyList options={options} load={load} onOpen={open} onRetry={refresh} />}
        {sheet.mode === "detail" && detailOption && (
          <>
            <SpaceDetailSheet
              option={detailOption}
              ageSeconds={spaceAge(detailOption.id)}
              load={detail.load}
              routing={routing}
              onRoute={() => routeTo(detailOption)}
              onClose={closeSheet}
              onRetry={detail.retry}
            />
            {routeError && <Text style={styles.routeError}>{routeError}</Text>}
          </>
        )}
        {sheet.mode === "route" && (
          <RouteCard
            route={sheet.route}
            target={optionById(sheet.id)}
            targetTitle={sheet.title}
            ageSeconds={state.spaces[sheet.id] ? spaceAge(sheet.id) : null}
            onEnd={closeSheet}
          />
        )}
      </SheetFrame>

      {replacement && (
        <View style={[styles.prompt, { bottom: sheetH + 12 }]}>
          <RouteReplacementPrompt replacement={replacement} onAccept={acceptReplacement} onKeep={keepRoute} />
        </View>
      )}

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
  prompt: { position: "absolute", left: 16, right: 16 },
  routeError: { fontFamily: font.semibold, fontSize: 13, color: ink.black, marginTop: 8, marginHorizontal: 4 },
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
