import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getApi } from "@/api/client";
import { FIND_RADIUS_M, type FrameAccepted, type RealtimeEvent } from "@/api/types";
import { AccountMenu } from "@/components/AccountMenu";
import { CurbMap } from "@/components/map/CurbMap";
import { MapErrorCard } from "@/components/map/MapErrorCard";
import { StatusPill } from "@/components/StatusPill";
import { MapLegend } from "@/components/MapLegend";
import { BookingConfirmation } from "@/components/find/BookingConfirmation";
import { DrivewayDetailSheet } from "@/components/find/DrivewayDetailSheet";
import { PaymentSheet } from "@/components/find/PaymentSheet";
import { NearbyList } from "@/components/find/NearbyList";
import { NewSpotBanner } from "@/components/find/NewSpotBanner";
import { RouteCard } from "@/components/find/RouteCard";
import { RouteReplacementPrompt } from "@/components/find/RouteReplacementPrompt";
import { SpaceDetailSheet } from "@/components/find/SpaceDetailSheet";
import { SHEET_PEEK, SheetFrame } from "@/components/sheet/SheetFrame";
import { CameraOverlay } from "@/components/CameraOverlay";
import { DraggablePip } from "@/components/DraggablePip";
import { font, ink, radius, SEP } from "@/config/tokens";
import { DEMO_DRIVER } from "@/data/mock/marina";
import { DemoModeBadge } from "@/demo/DemoModeBadge";
import { getDeviceId, newCaptureSessionId, type FrameContext } from "@/features/capture/detectionUpload";
import { useDriverLocation } from "@/features/capture/useDriverLocation";
import { ageSeconds } from "@/features/find/freshness";
import { mergeAlert, newOpening, worthInterruptingRoute, type SpotAlert } from "@/features/find/newSpots";
import {
  findOptions,
  mapPills,
  mapSignature,
  mapStalls,
  myReservation,
  type FindOption,
  type SearchArea,
} from "@/features/find/options";
import { replacementFor, requestRoute, type Route } from "@/features/find/route";
import { useFreshnessClock } from "@/features/find/useFreshnessClock";
import { useBooking } from "@/features/find/useBooking";
import { useCheckoutWallet, usePaymentPhase } from "@/features/find/useCheckoutWallet";
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
import type { ParkingState } from "@/realtime/reducer";

type Sheet =
  | { mode: "list" }
  | { mode: "detail"; id: string }
  | { mode: "driveway"; id: string }
  | { mode: "route"; id: string; position: LngLat; route: Route; initialConfidencePercent: number | null };

export default function FindScreen() {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const mapRef = useRef<MapController>(null);
  const send: MapController["send"] = useCallback((m) => mapRef.current?.send(m), []);

  const focused = useScreenFocused();
  const appActive = useAppActive();
  const live = getApi().mode === "live";
  // Scanning starts on its own (plan Task 14); Stop pauses it until Start.
  const [scanActive, setScanActive] = useState(true);
  const [cameraExpanded, setCameraExpanded] = useState(false);

  // Live: the device's location. Demo replay: the fixture driver on the calibrated block.
  const location = useDriverLocation(live && focused);
  const driver = useMemo(
    () =>
      location.position ? { position: location.position, heading: location.heading ?? 0 } : DEMO_DRIVER,
    [location.position, location.heading],
  );
  // Search area: the spec's fixed 0.5 mi around the driver (live) or the demo block.
  // Fixture coordinates belong only to explicitly labeled Demo replay mode.
  const searchCenter = live ? location.position : HOME_CAMERA.center;
  const area = useMemo<SearchArea | null>(() => (searchCenter ? { center: searchCenter, radiusM: FIND_RADIUS_M } : null), [searchCenter]);

  // New-opening alerts. Realtime events arrive outside render, so the handler
  // reads the latest screen state through a ref.
  const [spotAlert, setSpotAlert] = useState<SpotAlert | null>(null);
  const latest = useRef<{ state: ParkingState; area: SearchArea | null; driver: LngLat; routeTargetM: number | null } | null>(null);
  const onRealtimeEvent = useCallback((event: RealtimeEvent) => {
    const L = latest.current;
    if (!L) return;
    const hit = newOpening(event, L.state, L.area, Date.now());
    if (!hit) return;
    if (L.routeTargetM != null && !worthInterruptingRoute(hit.position, L.driver, L.routeTargetM)) return;
    setSpotAlert((prev) => mergeAlert(prev, hit.id, Date.now()));
    haptics.tap();
  }, []);
  const dismissAlert = useCallback(() => setSpotAlert(null), []);

  const { state, load, refresh, dispatchEvent, mode, realtime } = useParkingState(searchCenter, onRealtimeEvent);
  const userId = useSession().session?.user.id ?? null;
  const now = useFreshnessClock(state.spaces);
  const options = useMemo(
    () => searchCenter ? findOptions(state, now, driver.position, userId, area) : [],
    [state, now, driver.position, userId, area, searchCenter],
  );
  // Booked driveways are map context only; never list them or offer them as a replacement.
  const offered = useMemo(() => options.filter((o) => !o.booked), [options]);
  const reservation = myReservation(options);
  const { checkout, reserve, pay, cancel, reset } = useDrivewayBooking(() => haptics.success());

  // Metadata for on-device camera detections.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [captureSession] = useState(newCaptureSessionId);
  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);
  const frameContext = useCallback((): FrameContext | null => {
    if (!deviceId) return null;
    const pos = location.position ?? (live ? null : DEMO_DRIVER.position);
    if (!pos) return null;
    return {
      lat: pos[1],
      lng: pos[0],
      accuracy_m: location.accuracyM,
      heading: location.heading ?? DEMO_DRIVER.heading,
      device_id: deviceId,
      session_id: captureSession,
    };
  }, [live, location.position, location.accuracyM, location.heading, deviceId, captureSession]);

  /** Self-feedback: server confirmed a spot in the detection response → inject into reducer. */
  const onSpotConfirmed = useCallback(
    (result: FrameAccepted) => {
      if (!result.space) return;
      const now = new Date().toISOString();
      dispatchEvent({
        type: "space.opened",
        entity_id: result.space.id,
        entity_version: result.space.version,
        occurred_at: now,
        payload: result.space as unknown as Record<string, unknown>,
      });
      if (result.zone) {
        dispatchEvent({
          type: "sign_rule.updated",
          entity_id: result.zone.id,
          entity_version: result.zone.version,
          occurred_at: now,
          payload: result.zone as unknown as Record<string, unknown>,
        });
      }
    },
    [dispatchEvent],
  );

  const signature = mapSignature(options);

  const [sheetState, setSheet] = useState<Sheet>({ mode: "list" });
  const [selectedState, setSelectedId] = useState<string | null>(null);
  // A browsed opening that expired or was taken closes its details. While routing,
  // the replacement prompt handles it instead, so the route never changes silently.
  const detailGone = sheetState.mode === "detail" && !options.some((o) => o.id === sheetState.id);
  const sheet = useMemo<Sheet>(() => (detailGone ? { mode: "list" } : sheetState), [detailGone, sheetState]);
  const selectedId = detailGone ? null : selectedState;
  const [mapError, setMapError] = useState<string | null>(null);
  // Bumps on every mapReady so a reloaded map gets the full state again.
  const [mapGen, setMapGen] = useState(0);
  const [mapKey, setMapKey] = useState(0);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [keptRoutes, setKeptRoutes] = useState<Record<string, true>>({});

  useEffect(() => {
    const target = sheet.mode === "route" ? options.find((o) => o.id === sheet.id) : undefined;
    latest.current = { state, area, driver: driver.position, routeTargetM: sheet.mode === "route" ? (target?.distanceM ?? Infinity) : null };
  }, [state, area, driver.position, sheet, options]);

  const detailId = sheet.mode === "detail" && state.spaces[sheet.id] ? sheet.id : null;
  const detail = useSpaceDetail(detailId);
  const optionById = (id: string) => options.find((o) => o.id === id) ?? null;
  const spaceAge = (id: string) => ageSeconds(state.spaces[id]?.last_observed_at ?? null, now);

  // --- push state to the map (only when what's drawn changes) ---------------

  useEffect(() => {
    send({ type: "setStalls", stalls: mapStalls(offered) });
    send({ type: "setPills", pills: mapPills(options) });
    // `options` changes every tick; the signature only when a bay appears, ages or goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, send, mapGen]);

  useEffect(() => {
    if (live && !location.position) return;
    send({ type: "setCarPosition", position: driver.position, heading: driver.heading });
  }, [driver, live, location.position, send, mapGen]);

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
  const [screen, setScreen] = useState({ w: 0, h: 0 });
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
        setSheet({ mode: "route", id: o.id, position: o.position, route, initialConfidencePercent: o.confidencePercent ?? null });
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
      ? replacementFor(sheet.id, sheet.position, offered)
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
  const knownBooking = driveway
    ? checkout.booking?.driveway_id === driveway.id && checkout.phase === "confirmed"
      ? checkout.booking
      : Object.values(state.bookings).find((b) => b.driveway_id === driveway.id && b.driver_id === userId && b.state === "CONFIRMED")
    : undefined;
  // After a reload the confirmation event is gone; the driveway still names its booking.
  const bookedByMe = driveway?.state === "BOOKED" && driveway.held_by_user_id === userId;
  const myBooking = useBooking(bookedByMe ? (driveway?.active_booking?.id ?? null) : null, knownBooking ?? undefined) ?? knownBooking;
  const inCheckout = checkout.phase === "review" || checkout.phase === "failed";
  const checkoutWallet = useCheckoutWallet(inCheckout);
  const paymentStep = usePaymentPhase(checkout.booking?.id ?? null, checkout.phase === "processing");
  const drivewayDone = () => {
    reset();
    closeSheet();
  };

  return (
    <View style={styles.root} onLayout={(e) => setScreen({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <StatusBar style="dark" />
      <CurbMap key={mapKey} ref={mapRef} mood="clay" reduceMotion={reduceMotion} onMapMessage={onMapMessage} />

      <View style={[styles.top, { top: insets.top + 8 }]}>
        <View style={styles.leftCol}>
          {mode === "demo" && <DemoModeBadge />}
          {realtime === "reconnecting" && <StatusPill text={`Reconnecting${SEP}showing last update`} />}
        </View>
        <View style={styles.mapButtons}>
          <AccountMenu />
          <MapLegend />
        </View>
      </View>

      <DraggablePip
        areaWidth={screen.w}
        areaHeight={screen.h}
        topInset={insets.top + 52}
        bottomInset={visibleSheetH}
        reduceMotion={reduceMotion}
        expanded={cameraExpanded}
      >
        <CameraOverlay
          active={focused && appActive}
          sampling={live && scanActive && location.position != null}
          frameContext={frameContext}
          reduceMotion={reduceMotion}
          onSpotConfirmed={onSpotConfirmed}
          onStartScan={() => setScanActive(true)}
          onStopScan={() => setScanActive(false)}
          onExpandedChange={setCameraExpanded}
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
              <Text style={styles.locationText}>Curb uses your precise location to find open parking within half a mile.</Text>
              <Pressable
                onPress={() => (location.canAskAgain ? location.request() : Linking.openSettings())}
                accessibilityRole="button"
                style={({ pressed }) => [styles.locationButton, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.locationButtonText}>{location.canAskAgain ? "Allow location" : "Open Settings"}</Text>
              </Pressable>
            </View>
          ) : (
            <NearbyList
              options={offered}
              reservation={reservation}
              load={load}
              locating={live && !location.position}
              onOpen={open}
              onRetry={refresh}
            />
          ))}
        {sheet.mode === "detail" && detailOption && (
          <>
            <SpaceDetailSheet
              option={detailOption}
              ageSeconds={spaceAge(detailOption.id)}
              confidencePercent={detailOption.confidencePercent ?? 0}
              detectionConfidence={state.spaces[detailOption.id]?.detection_confidence ?? 0}
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
                wallet={checkoutWallet.wallet}
                walletFailed={checkoutWallet.failed}
                topUp={checkoutWallet.topUp}
                step={paymentStep}
                onTopUp={checkoutWallet.requestTopUp}
                onPay={pay}
                onCancel={() => cancel(driveway)}
              />
            ) : (
              <DrivewayDetailSheet
                driveway={driveway}
                distanceM={drivewayOption.distanceM}
                holding={checkout.phase === "holding"}
                own={drivewayOption.own}
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
            key={sheet.id}
            route={sheet.route}
            target={optionById(sheet.id)}
            initialConfidencePercent={sheet.initialConfidencePercent}
            observedAt={state.spaces[sheet.id]?.last_observed_at ?? null}
            onEnd={closeSheet}
          />
        )}
      </SheetFrame>

      {spotAlert && (
        <View style={[styles.banner, { top: insets.top + 8 }]}>
          <NewSpotBanner
            key={spotAlert.ids[0]}
            alert={spotAlert}
            options={offered}
            routing={sheet.mode === "route"}
            reduceMotion={reduceMotion}
            onOpen={open}
            onDismiss={dismissAlert}
          />
        </View>
      )}

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
  banner: { position: "absolute", left: 0, right: 0, zIndex: 30 },
  locationOff: { alignItems: "center", paddingVertical: 20, paddingHorizontal: 16, gap: 6 },
  locationTitle: { fontFamily: font.bold, fontSize: 16, color: ink.black, textAlign: "center" },
  locationText: { fontFamily: font.regular, fontSize: 14, color: ink.grey500, textAlign: "center" },
  locationButton: { marginTop: 8, height: 42, paddingHorizontal: 18, borderRadius: radius.control, backgroundColor: ink.black, justifyContent: "center" },
  locationButtonText: { fontFamily: font.bold, fontSize: 14, color: ink.white, marginTop: 2 },
  routeError: { fontFamily: font.semibold, fontSize: 13, color: ink.black, marginTop: 8, marginHorizontal: 4 },
  mapError: { position: "absolute", left: 16, right: 16 },
});
