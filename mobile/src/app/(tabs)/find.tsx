import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getApi } from "@/api/client";
import { AccountMenu } from "@/components/AccountMenu";
import { CurbMap } from "@/components/map/CurbMap";
import { MapErrorCard } from "@/components/map/MapErrorCard";
import { StatusPill } from "@/components/StatusPill";
import { MapLegend } from "@/components/MapLegend";
import { BookingConfirmation } from "@/components/find/BookingConfirmation";
import { DrivewayDetailSheet } from "@/components/find/DrivewayDetailSheet";
import { PaymentSheet } from "@/components/find/PaymentSheet";
import { NearbyList } from "@/components/find/NearbyList";
import { RouteCard } from "@/components/find/RouteCard";
import { RouteReplacementPrompt } from "@/components/find/RouteReplacementPrompt";
import { SpaceDetailSheet } from "@/components/find/SpaceDetailSheet";
import { SHEET_PEEK, SheetFrame } from "@/components/sheet/SheetFrame";
import { CameraOverlay } from "@/components/CameraOverlay";
import { DraggablePip } from "@/components/DraggablePip";
import { font, ink, radius } from "@/config/tokens";
import { DEMO_DRIVER } from "@/data/mock/marina";
import { DemoModeBadge } from "@/demo/DemoModeBadge";
import { getDeviceId, newCaptureSessionId, type FrameContext } from "@/features/capture/frameUpload";
import { useDriverLocation } from "@/features/capture/useDriverLocation";
import { ageSeconds } from "@/features/find/freshness";
import { findOptions, mapPills, mapSignature, mapStalls, mapZones, type FindOption } from "@/features/find/options";
import { replacementFor, requestRoute, type Route } from "@/features/find/route";
import { useFreshnessClock } from "@/features/find/useFreshnessClock";
import { useDrivewayBooking } from "@/features/find/useDrivewayBooking";
import { useParkingState } from "@/features/find/useParkingState";
import { useSpaceDetail } from "@/features/find/useSpaceDetail";
import { useSession } from "@/features/session/SessionContext";
import { useAppActive } from "@/hooks/useAppActive";
import { useScreenFocused } from "@/hooks/useScreenFocused";
import { haptics } from "@/lib/haptics";
import { useReduceMotion } from "@/hooks/useReduceMotion";
import { HOME_CAMERA, SPOT_CAMERA } from "@/map/mapConfig";
import type { LngLat, MapController, MapToApp } from "@/map/messages";

type Sheet =
  | { mode: "list" }
  | { mode: "detail"; id: string }
  | { mode: "driveway"; id: string }
  | { mode: "route"; id: string; title: string; position: LngLat; route: Route };

export default function FindScreen() {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const mapRef = useRef<MapController>(null);
  const send: MapController["send"] = useCallback((m) => mapRef.current?.send(m), []);

  const focused = useScreenFocused();
  const appActive = useAppActive();
  const live = getApi().mode === "live";

  // Live: the device's location. Demo replay: the fixture driver on the calibrated block.
  const location = useDriverLocation(live && focused);
  const driver = useMemo(
    () =>
      live && location.position ? { position: location.position, heading: location.heading ?? 0 } : DEMO_DRIVER,
    [live, location.position, location.heading],
  );
  const { state, load, refresh, mode, realtime } = useParkingState(live ? location.position : HOME_CAMERA.center);
  const userId = useSession().session?.user.id ?? null;
  const now = useFreshnessClock();
  const options = useMemo(() => findOptions(state, now, driver.position, userId), [state, now, driver.position, userId]);
  const { checkout, reserve, pay, cancel, reset } = useDrivewayBooking(() => haptics.success());

  // Frame metadata for camera sampling.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [captureSession] = useState(newCaptureSessionId);
  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);
  const frameContext = useCallback((): FrameContext | null => {
    if (!location.position || !deviceId) return null;
    return {
      lat: location.position[1],
      lng: location.position[0],
      accuracy_m: location.accuracyM,
      heading: location.heading,
      device_id: deviceId,
      session_id: captureSession,
    };
  }, [location.position, location.accuracyM, location.heading, deviceId, captureSession]);
  const signature = mapSignature(options);

  const [sheetState, setSheet] = useState<Sheet>({ mode: "list" });
  const [selectedState, setSelectedId] = useState<string | null>(null);
  // A browsed opening that expired or was taken closes its details. While routing,
  // the replacement prompt handles it instead, so the route never changes silently.
  const detailGone = sheetState.mode === "detail" && !options.some((o) => o.id === sheetState.id);
  const sheet: Sheet = detailGone ? { mode: "list" } : sheetState;
  const selectedId = detailGone ? null : selectedState;
  const [mapError, setMapError] = useState<string | null>(null);
  // Bumps on every mapReady so a reloaded map gets the full state again.
  const [mapGen, setMapGen] = useState(0);
  const [mapKey, setMapKey] = useState(0);
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
  }, [state.zones, send, mapGen]);

  useEffect(() => {
    send({ type: "setStalls", stalls: mapStalls(options) });
    send({ type: "setPills", pills: mapPills(options) });
    // `options` changes every tick; the signature only when a bay appears, ages or goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, send, mapGen]);

  useEffect(() => {
    send({ type: "setCarPosition", position: driver.position, heading: driver.heading });
  }, [driver, send, mapGen]);

  // Live: center on the driver once, at the first location fix.
  const centered = useRef(false);
  useEffect(() => {
    if (!live || !location.position || centered.current) return;
    centered.current = true;
    send({ type: "flyTo", camera: { center: location.position, zoom: HOME_CAMERA.zoom, pitch: HOME_CAMERA.pitch, durationMs: 1200 } });
  }, [live, location.position, send]);

  // Haptics for checkout milestones.
  const lastPhase = useRef(checkout.phase);
  useEffect(() => {
    if (checkout.phase === lastPhase.current) return;
    if (checkout.phase === "review" && lastPhase.current === "holding") haptics.hold();
    if (checkout.phase === "failed") haptics.error();
    lastPhase.current = checkout.phase;
  }, [checkout.phase]);


  useEffect(() => {
    send({ type: "selectSpot", id: selectedId });
  }, [selectedId, send, mapGen]);

  const [sheetH, setSheetH] = useState(260);
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const [area, setArea] = useState({ w: 0, h: 0 });
  // Swiped down: the map gets the space back for framing spots and routes.
  const visibleSheetH = sheetCollapsed ? SHEET_PEEK : sheetH;
  const padding = useMemo(() => ({ top: insets.top + 70, bottom: visibleSheetH + 12, left: 0, right: 0 }), [insets.top, visibleSheetH]);
  useEffect(() => {
    send({ type: "setPadding", padding });
  }, [padding, send, mapGen]);

  // --- interactions ---------------------------------------------------------

  /** Marker or row tap: select, frame, and open details. Never routes by itself. */
  const open = useCallback(
    (o: FindOption) => {
      haptics.select();
      setSelectedId(o.id);
      setRouteError(null);
      if (sheet.mode !== "route") setSheet(o.kind === "driveway" ? { mode: "driveway", id: o.id } : { mode: "detail", id: o.id });
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
        haptics.tap();
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
      if (msg.type === "mapReady") {
        setMapError(null);
        setMapGen((g) => g + 1);
      }
      if (msg.type === "spotTapped") {
        const o = options.find((x) => x.id === msg.id);
        if (o) open(o);
      }
    },
    [options, open],
  );

  const detailOption = sheet.mode === "detail" ? optionById(sheet.id) : null;

  // Driveway checkout. The hold outlives the sheet: closing it keeps the hold, and
  // reopening returns to payment. A driveway this driver already booked shows its receipt.
  const driveway = sheet.mode === "driveway" ? state.driveways[sheet.id] : undefined;
  const drivewayOption = sheet.mode === "driveway" ? optionById(sheet.id) : null;
  const myBooking =
    driveway &&
    (checkout.booking?.driveway_id === driveway.id && checkout.phase === "confirmed"
      ? checkout.booking
      : Object.values(state.bookings).find((b) => b.driveway_id === driveway.id && b.driver_id === userId && b.state === "CONFIRMED"));
  const drivewayDone = () => {
    reset();
    closeSheet();
  };

  return (
    <View style={styles.root} onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <StatusBar style="dark" />
      <CurbMap key={mapKey} ref={mapRef} mood="clay" reduceMotion={reduceMotion} onMapMessage={onMapMessage} />

      <View style={[styles.top, { top: insets.top + 8 }]}>
        <View style={styles.leftCol}>
          {mode === "demo" && <DemoModeBadge />}
          {realtime === "reconnecting" && <StatusPill text="Reconnecting · showing last update" />}
        </View>
        <View style={styles.mapButtons}>
          <AccountMenu />
          <MapLegend />
        </View>
      </View>

      <DraggablePip
        areaWidth={area.w}
        areaHeight={area.h}
        topInset={insets.top + 52}
        bottomInset={visibleSheetH}
        reduceMotion={reduceMotion}
      >
        <CameraOverlay
          active={focused && appActive}
          sampling={live && location.status === "granted"}
          frameContext={frameContext}
          reduceMotion={reduceMotion}
        />
      </DraggablePip>

      {/* The tab bar below already covers the home-indicator inset. */}
      <SheetFrame
        bottomInset={0}
        onContentHeight={setSheetH}
        onCollapsedChange={setSheetCollapsed}
        expandKey={sheet.mode === "list" ? "list" : `${sheet.mode}:${sheet.id}`}
      >
        {sheet.mode === "list" &&
          (live && location.status === "denied" ? (
            <View style={styles.locationOff}>
              <Text style={styles.locationTitle}>Location is off</Text>
              <Text style={styles.locationText}>Curb uses your precise location to find legal parking within half a mile.</Text>
              <Pressable
                onPress={() => (location.canAskAgain ? location.request() : Linking.openSettings())}
                accessibilityRole="button"
                style={({ pressed }) => [styles.locationButton, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.locationButtonText}>{location.canAskAgain ? "Allow location" : "Open Settings"}</Text>
              </Pressable>
            </View>
          ) : (
            <NearbyList options={options} load={load} locating={live && !location.position} onOpen={open} onRetry={refresh} />
          ))}
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
        {sheet.mode === "driveway" && driveway && drivewayOption && (
          <>
            {myBooking ? (
              <BookingConfirmation
                driveway={driveway}
                booking={myBooking}
                routing={routing}
                onRoute={() => routeTo(drivewayOption)}
                onDone={drivewayDone}
              />
            ) : checkout.booking && (checkout.phase === "review" || checkout.phase === "processing" || checkout.phase === "failed") ? (
              <PaymentSheet
                driveway={driveway}
                booking={checkout.booking}
                phase={checkout.phase}
                error={checkout.error}
                demo={mode === "demo"}
                onPay={pay}
                onCancel={() => cancel(driveway)}
              />
            ) : (
              <DrivewayDetailSheet
                driveway={driveway}
                distanceM={drivewayOption.distanceM}
                holding={checkout.phase === "holding"}
                error={checkout.error}
                onReserve={() => reserve(driveway)}
                onClose={closeSheet}
              />
            )}
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
        <View style={[styles.prompt, { bottom: visibleSheetH + 12 }]}>
          <RouteReplacementPrompt replacement={replacement} onAccept={acceptReplacement} onKeep={keepRoute} />
        </View>
      )}

      {mapError && (
        <View style={[styles.mapError, { top: insets.top + 170 }]}>
          <MapErrorCard
            message={mapError}
            onRetry={() => {
              setMapError(null);
              setMapKey((k) => k + 1);
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: "absolute", left: 16, right: 16, zIndex: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  leftCol: { gap: 10, alignItems: "flex-start" },
  mapButtons: { gap: 10, alignItems: "flex-end", zIndex: 10 },
  prompt: { position: "absolute", left: 16, right: 16 },
  locationOff: { alignItems: "center", paddingVertical: 20, paddingHorizontal: 16, gap: 6 },
  locationTitle: { fontFamily: font.bold, fontSize: 16, color: ink.black, textAlign: "center" },
  locationText: { fontFamily: font.regular, fontSize: 14, color: ink.grey500, textAlign: "center" },
  locationButton: { marginTop: 8, height: 42, paddingHorizontal: 18, borderRadius: radius.control, backgroundColor: ink.black, justifyContent: "center" },
  locationButtonText: { fontFamily: font.bold, fontSize: 14, color: ink.white, marginTop: 2 },
  routeError: { fontFamily: font.semibold, fontSize: 13, color: ink.black, marginTop: 8, marginHorizontal: 4 },
  mapError: { position: "absolute", left: 16, right: 16 },
});
