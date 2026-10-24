import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CurbMap } from "@/components/map/CurbMap";
import { MapLegend } from "@/components/MapLegend";
import { MoodToggle } from "@/components/MoodToggle";
import { NavBanner } from "@/components/nav/NavBanner";
import { NavBottomCard } from "@/components/nav/NavBottomCard";
import { OptionsSheet } from "@/components/OptionsSheet";
import { SearchBar } from "@/components/SearchBar";
import { SharingLivePip } from "@/components/SharingLivePip";
import { font, ink, radius } from "@/config/tokens";
import type { LngLat } from "@/data/geo";
import { CAR_START, DESTINATION } from "@/data/mock/marina";
import { eta, formatDistance, instructionFor, nextStep, spotStatusText } from "@/data/navText";
import { formatClock } from "@/data/prediction";
import { getRoutingProvider, type Route } from "@/data/provider";
import { pickSpotOptions, type SpotOption } from "@/data/spots";
import { useCurbData } from "@/hooks/useCurbData";
import { useDriveSim } from "@/hooks/useDriveSim";
import { useMood } from "@/hooks/useMood";
import { useNow } from "@/hooks/useNow";
import { useReduceMotion } from "@/hooks/useReduceMotion";
import { HOME_CAMERA, SPOT_CAMERA } from "@/map/mapConfig";
import type { MapController, MapPill, MapToApp } from "@/map/messages";
import { BAY_CENTER_OFFSET_M, buildStalls } from "@/map/curbScene";

const PILL_KIND = { street: "free", likely: "metered", driveway: "driveway" } as const;
const ARRIVAL_LEAD_MIN = 4;
const SHARED_SPOTS = 3;

export default function FindParkingScreen() {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const { setting, setSetting, mood } = useMood();
  const mapRef = useRef<MapController>(null);
  const send: MapController["send"] = useCallback((m) => mapRef.current?.send(m), []);
  const now = useNow();

  const segments = useCurbData();
  const options = useMemo(() => pickSpotOptions(segments, DESTINATION.position, BAY_CENTER_OFFSET_M), [segments]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const navigating = route !== null;

  // --- push state to the map ------------------------------------------------

  useEffect(() => {
    if (!segments.length) return;
    send({ type: "setSegments", segments });
    send({ type: "setStalls", stalls: buildStalls(segments) });
  }, [segments, send]);

  useEffect(() => {
    const pills: MapPill[] = options.map((o) => ({
      segmentId: o.segmentId,
      kind: PILL_KIND[o.kind],
      label: o.kind === "street" ? "P Free" : o.price,
      position: o.anchor,
    }));
    send({ type: "setPills", pills });
    if (!selectedId && options[0]) setSelectedId(options[0].segmentId);
  }, [options, selectedId, send]);

  useEffect(() => {
    send({ type: "setDestination", position: DESTINATION.position, label: DESTINATION.label });
    send({ type: "setCarPosition", position: CAR_START.position, heading: CAR_START.heading, follow: false });
  }, [send]);

  useEffect(() => {
    send({ type: "selectSpot", segmentId: selectedId });
  }, [selectedId, send]);

  // Map padding follows the native chrome so camera targets land in the visible area.
  const [sheetH, setSheetH] = useState(250);
  const padding = useMemo(
    () => ({ top: insets.top + 70, bottom: sheetH + 12, left: 0, right: 0 }),
    [insets.top, sheetH],
  );
  useEffect(() => {
    if (!navigating) send({ type: "setPadding", padding });
  }, [padding, navigating, send]);

  // --- interactions ---------------------------------------------------------

  const selectOption = useCallback(
    (o: SpotOption) => {
      setSelectedId(o.segmentId);
      send({ type: "flyTo", camera: { center: o.anchor, zoom: SPOT_CAMERA.zoom, pitch: SPOT_CAMERA.pitch, padding, durationMs: SPOT_CAMERA.durationMs } });
    },
    [padding, send],
  );

  const onMapMessage = useCallback(
    (msg: MapToApp) => {
      if (msg.type === "mapError") setMapError(msg.message);
      if (msg.type === "mapReady") setMapError(null);
      if (msg.type === "spotTapped" && !navigating) {
        const o = options.find((x) => x.segmentId === msg.segmentId);
        if (o) selectOption(o);
      }
    },
    [navigating, options, selectOption],
  );

  const startNav = useCallback(async () => {
    const target = segments.find((s) => s.id === selectedId);
    if (!target) return;
    const r = await getRoutingProvider().routeTo(CAR_START.position, CAR_START.heading, target);
    setTargetId(target.id);
    setRoute(r);
    send({ type: "startNav", route: r.line, targetSegmentId: target.id });
  }, [segments, selectedId, send]);

  const onCar = useCallback(
    (position: LngLat, heading: number) => send({ type: "setCarPosition", position, heading, follow: true }),
    [send],
  );
  const sim = useDriveSim(route?.line ?? null, route?.lengthM ?? 0, onCar);

  const endNav = useCallback(() => {
    setRoute(null);
    setTargetId(null);
    send({ type: "stopNav" });
    send({ type: "setCarPosition", position: CAR_START.position, heading: CAR_START.heading, follow: false });
    send({ type: "flyTo", camera: { ...HOME_CAMERA, padding, durationMs: 1400 } });
  }, [padding, send]);

  // --- layout ---------------------------------------------------------------

  const arrival = formatClock(new Date(now.getTime() + ARRIVAL_LEAD_MIN * 60_000));
  const target = segments.find((s) => s.id === targetId);
  const step = route ? nextStep(route, sim.traveledM) : null;
  const timing = route ? eta(route, sim.traveledM, now) : null;

  return (
    <View style={styles.root}>
      <StatusBar style={navigating || mood !== "clay" ? "light" : "dark"} />
      <CurbMap ref={mapRef} mood={mood} reduceMotion={reduceMotion} onMapMessage={onMapMessage} />

      {!navigating ? (
        <>
          <View style={[styles.top, { top: insets.top + 8 }]}>
            <SearchBar destination={DESTINATION.address} arrivalLabel={`Arriving around ${arrival}`} />
            <View style={styles.subRow}>
              <SharingLivePip spotsShared={SHARED_SPOTS} reduceMotion={reduceMotion} />
              <View style={styles.mapButtons}>
                <MoodToggle value={setting} onChange={setSetting} />
                <MapLegend />
              </View>
            </View>
          </View>

          <OptionsSheet
            title={`Park near ${DESTINATION.label}`}
            options={options}
            selectedId={selectedId}
            onSelect={selectOption}
            onGo={startNav}
            bottomInset={insets.bottom}
            onContentHeight={setSheetH}
          />
        </>
      ) : (
        <>
          <View style={[styles.top, { top: insets.top + 8 }]}>
            {step && (
              <NavBanner
                maneuver={step.maneuver}
                distanceLabel={formatDistance(step.atM - sim.traveledM)}
                instruction={instructionFor(step)}
              />
            )}
            <View style={styles.subRow}>
              <SharingLivePip spotsShared={SHARED_SPOTS} reduceMotion={reduceMotion} />
              <MoodToggle value={setting} onChange={setSetting} />
            </View>
          </View>
          {timing && (
            <View style={styles.bottom}>
              <NavBottomCard
                etaMinutes={timing.minutes}
                distanceLabel={timing.distanceLabel}
                arrivalTime={timing.arrivalTime}
                spotStatusText={spotStatusText(target)}
                driving={sim.driving}
                arrived={sim.arrived}
                bottomInset={insets.bottom}
                onToggleDrive={sim.toggle}
                onEnd={endNav}
              />
            </View>
          )}
        </>
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
  top: { position: "absolute", left: 16, right: 16 },
  // Round map buttons sit under the account button, right-aligned with it.
  mapButtons: { gap: 10, alignItems: "flex-end", marginRight: 1 },
  subRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 10 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
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
