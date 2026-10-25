import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { FrameAccepted, OnDeviceInference, SignFeedback } from "@/api/types";
import { font } from "@/config/tokens";
import { vision } from "@/config/vision";
import { isParkingReading } from "@/features/capture/scannerPresentation";
import type { DeepReadonly } from "@/features/capture/DetectionUploadController";

type Tab = "overview" | "gaps" | "signs";
type Props = {
  analysis: DeepReadonly<FrameAccepted> | null;
  lastSigns: DeepReadonly<SignFeedback[]>;
  signCount: number;
  fresh: boolean;
  inference?: OnDeviceInference | null;
  deliveryText?: string;
  deliveryDetail?: string;
  initialTab?: Tab;
};

/** A compact instrument panel for presenting what the vision pipeline observed. */
export function ScannerDetails({ analysis, lastSigns, signCount, fresh, inference = null, deliveryText, deliveryDetail, initialTab = "overview" }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const current = analysis?.sign_feedback ?? [];
  const signs = current.length ? current : lastSigns;
  const gaps = fresh ? analysis?.gap_bboxes ?? [] : [];
  const confirmed = gaps.filter((bbox) => analysis?.tracked_gaps?.some(
    (gap) => gap.confirmed && gap.bbox.every((value, axis) => value === bbox[axis]),
  )).length;
  const goodSign = signs.find(isParkingReading);
  const gapState = !analysis ? "Waiting for server gap analysis" : analysis.gap_bboxes === undefined ? "Restart the API to enable gap details"
    : !fresh ? "Analysis delayed — gap overlay hidden" : `${gaps.length} gap${gaps.length === 1 ? "" : "s"} · ${confirmed} confirmed`;
  return <View style={styles.panel}>
    <View style={styles.heading}><Text style={styles.eyebrow}>Scan details</Text>
      <View style={styles.connection}><View style={[styles.dot, { backgroundColor: fresh ? vision.vehicle : vision.sign }]} />
        <Text style={styles.connectionText}>{fresh ? "Live" : analysis ? "Updating" : "Connecting"}</Text></View>
    </View>
    <View style={styles.tabs} accessibilityRole="tablist">
      {([['overview', 'Overview'], ['gaps', 'Gaps'], ['signs', 'Signs']] as const).map(([id, label]) =>
        <Pressable key={id} accessibilityRole="tab" accessibilityLabel={`${label} diagnostics`} accessibilityState={{ selected: id === tab }} onPress={() => setTab(id)}
          style={[styles.tab, id === tab && styles.selectedTab]}><Text style={[styles.tabText, id === tab && styles.selectedTabText]}>{label}</Text></Pressable>)}
    </View>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {tab === "overview" && <>
        <View style={styles.stats}>
          {([['Vehicles', inference?.vehicles.length ?? analysis?.vehicle_count ?? 0, '#202D26'],
            ['Openings', gaps.length, '#202D26'], ['Signs', signCount, '#202D26']] as const).map(([label, value, color]) =>
            <View key={label} style={styles.stat}><Text style={[styles.statValue, { color }]}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open gap details" onPress={() => setTab("gaps")} style={styles.summaryRow}>
          <View style={[styles.dot, { backgroundColor: vision.gap }]} /><Text style={styles.summaryText}>{gapState}</Text><Text style={styles.chevron}>↗</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open sign details" onPress={() => setTab("signs")} style={styles.summaryRow}>
          <View style={[styles.dot, { backgroundColor: vision.sign }]} />
          <Text style={styles.summaryText} numberOfLines={2}>{goodSign?.reading ? `${fresh && current.length ? "Read" : "Last read"}: ${goodSign.reading.combined_summary}`
            : current.some((sign) => sign.state === "uncertain") ? "Sign needs a clearer view" : signCount ? "Reading sign text" : "No sign in view"}</Text>
          <Text style={styles.chevron}>↗</Text>
        </Pressable>
      </>}
      {tab === "gaps" && <>
        <Text style={styles.sectionSummary}>{gapState}</Text>
        {gaps.map((bbox, index) => {
          const gap = analysis?.tracked_gaps?.find((item) => item.bbox.every((value, axis) => value === bbox[axis]));
          const boundary = gap ? `${gap.left_track_id < 0 ? "frame edge" : `vehicle #${gap.left_track_id}`} → ${gap.right_track_id < 0 ? "frame edge" : `vehicle #${gap.right_track_id}`}` : "Waiting for stable vehicle tracks";
          return <View key={index} style={styles.gapCard}>
            <View style={styles.cardHeading}><Text style={styles.gapTitle}>{`GAP ${String(index + 1).padStart(2, '0')}`}</Text>
              <Text style={[styles.stateBadge, { color: "#36675E" }]}>{gap?.confirmed ? "CONFIRMED" : "CANDIDATE"}</Text></View>
            <Text style={styles.detail}>{`${Math.round(bbox[2] - bbox[0])} px wide · ${gap ? `${gap.duration.toFixed(1)}s observed` : "Acquiring tracks"}${gap?.median_width_meters != null ? ` · ${gap.median_width_meters.toFixed(1)} m` : ""}`}</Text>
            <Text style={styles.secondary}>{boundary}</Text>
          </View>;
        })}
        <Text style={styles.caption}>Cyan bands show image openings. Pixel width does not establish vehicle fit or curb legality.</Text>
      </>}
      {tab === "signs" && <>
        <Text style={styles.sectionSummary}>{fresh && current.length ? "Sign reading" : signs.length ? "Last sign reading" : "Sign reading"}</Text>
        {!signs.length && <Text style={styles.secondary}>{signCount ? "Sign detected — waiting for server reading feedback" : "No sign detected. Point the camera at a parking sign."}</Text>}
        {signs.map((sign) => <View key={sign.track_id} style={styles.signCard}>
          <View style={styles.cardHeading}><Text style={styles.signTitle}>{`SIGN ${String(sign.track_id).padStart(2, '0')}`}</Text>
            <Text style={[styles.stateBadge, { color: "#74633D" }]}>{sign.state === "gathering" ? `${sign.observations}/${sign.required_observations} VIEWS`
              : sign.state === "unavailable" ? "UNAVAILABLE" : sign.state === "uncertain" ? "NEEDS REVIEW" : isParkingReading(sign) ? "RULE READ" : "INFORMATIONAL"}</Text></View>
          {sign.state === "unavailable" && <Text style={styles.secondary}>Reading unavailable — server API key missing</Text>}
          {sign.reading && <>
            <Text style={styles.rawLabel}>EXTRACTED TEXT</Text>
            <Text selectable style={styles.raw}>{sign.reading.signs.map((item) => item.raw_text).filter(Boolean).join("\n\n") || "No sign text extracted"}</Text>
            <Text selectable style={styles.detail}>{sign.reading.combined_summary || "No readable summary returned"}</Text>
            <Text style={styles.secondary}>{[
              sign.reading.combined_hours,
              sign.reading.combined_max_duration_min != null ? `${sign.reading.combined_max_duration_min} min limit` : null,
              sign.reading.combined_price, ...sign.reading.combined_restrictions,
              `Reading score ${Math.round(sign.reading.confidence_score * 100)}%${sign.reading.flagged ? " · Needs review" : ""}`,
            ].filter(Boolean).join(" · ")}</Text>
          </>}
        </View>)}
      </>}
    </ScrollView>
    <Pressable accessibilityRole="link" accessibilityLabel="3D model credits" onPress={() => void Linking.openURL("https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept")} style={styles.credits}><Text style={styles.creditText}>Car model: Eric Chadwick / DGG · CC BY 4.0 · adapted</Text></Pressable>
    {deliveryText && <View style={styles.receipt}><Text style={styles.receiptText}>{deliveryText}</Text>
      {!!deliveryDetail && <Text style={styles.receiptDetail}>{deliveryDetail}</Text>}</View>}
  </View>;
}

const styles = StyleSheet.create({
  credits: { paddingHorizontal: 15, paddingBottom: 6 },
  creditText: { fontFamily: font.regular, fontSize: 8, color: "#737D70" },
  panel: { position: "absolute", left: 14, right: 14, bottom: 98, maxHeight: "40%", borderRadius: 22, borderCurve: "continuous",
    borderWidth: 1, borderColor: "#DCDDD4", backgroundColor: "#F5F5EF", overflow: "hidden" },
  heading: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eyebrow: { fontFamily: font.bold, fontSize: 16, letterSpacing: -0.3, color: "#263429" },
  connection: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  connectionText: { fontFamily: font.semibold, fontSize: 8, letterSpacing: 1, color: "#687368" },
  tabs: { flexDirection: "row", gap: 4, marginHorizontal: 12, padding: 3, borderRadius: 10, backgroundColor: "#EDEFE7" },
  tab: { flex: 1, minHeight: 40, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  selectedTab: { backgroundColor: "#E2E6DC" },
  tabText: { fontFamily: font.semibold, fontSize: 12, color: "#687368" },
  selectedTabText: { color: "#243027" },
  scroll: { flexShrink: 1, flexGrow: 0 },
  content: { paddingHorizontal: 15, paddingVertical: 11, gap: 8 },
  stats: { flexDirection: "row", paddingBottom: 9, borderBottomWidth: 0.5, borderBottomColor: vision.border },
  stat: { flex: 1, gap: 2 },
  statValue: { fontFamily: font.semibold, fontSize: 26, lineHeight: 28, fontVariant: ["tabular-nums"] },
  statLabel: { fontFamily: font.semibold, fontSize: 10, letterSpacing: 0, color: "#687368" },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
  summaryText: { flex: 1, fontFamily: font.regular, fontSize: 12, lineHeight: 18, color: "#243027" },
  chevron: { color: "#687368", fontSize: 13 },
  sectionSummary: { fontFamily: font.semibold, fontSize: 11, color: "#243027" },
  gapCard: { borderLeftWidth: 2, borderLeftColor: "#8CA99D", backgroundColor: "rgba(138,220,244,0.045)", padding: 10, borderRadius: 8, gap: 7 },
  signCard: { borderLeftWidth: 2, borderLeftColor: "#C5B27C", backgroundColor: "rgba(244,211,154,0.04)", padding: 11, borderRadius: 8, gap: 9 },
  cardHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  gapTitle: { fontFamily: font.bold, fontSize: 10, letterSpacing: 1.2, color: "#36675E" },
  signTitle: { fontFamily: font.bold, fontSize: 10, letterSpacing: 1.2, color: "#74633D" },
  stateBadge: { fontFamily: font.semibold, fontSize: 7, letterSpacing: 0.8, paddingHorizontal: 6, paddingVertical: 4,
    borderRadius: 5, backgroundColor: "rgba(255,255,255,0.06)" },
  detail: { fontFamily: font.regular, fontSize: 11, lineHeight: 17, color: "#243027" },
  secondary: { fontFamily: font.regular, fontSize: 10, lineHeight: 15, color: "#687368" },
  rawLabel: { fontFamily: font.semibold, fontSize: 10, letterSpacing: 0, color: "#6F796E", marginTop: 3 },
  raw: { fontFamily: font.semibold, fontSize: 13, lineHeight: 20, letterSpacing: 0.25, color: "#1F2D24" },
  caption: { fontFamily: font.regular, fontSize: 9, lineHeight: 14, color: "#687368" },
  receipt: { paddingHorizontal: 15, paddingVertical: 9, gap: 3, borderTopWidth: 0.5, borderTopColor: vision.border, backgroundColor: "#ECEFE6" },
  receiptText: { fontFamily: font.semibold, fontSize: 9, color: "#556256" },
  receiptDetail: { fontFamily: font.regular, fontSize: 9, color: "#687368" },
});
