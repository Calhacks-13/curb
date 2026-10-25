import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { FrameAccepted, OnDeviceInference, SignFeedback } from "@/api/types";
import { font } from "@/config/tokens";
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
  previewStatus?: string;
};

/** A compact instrument panel for presenting what the vision pipeline observed. */
export function ScannerDetails({ analysis, lastSigns, signCount, fresh, inference = null, deliveryText, deliveryDetail, initialTab = "overview", previewStatus }: Props) {
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
      <View style={styles.connection}><View style={[styles.dot, { backgroundColor: fresh ? "#111111" : "#999999" }]} />
        <Text style={styles.connectionText}>{fresh ? "Live" : analysis ? "Updating" : "Connecting"}</Text></View>
    </View>
    <View style={styles.tabs} accessibilityRole="tablist">
      {([['overview', 'Overview'], ['gaps', 'Gaps'], ['signs', 'Signs']] as const).map(([id, label]) =>
        <Pressable key={id} accessibilityRole="tab" accessibilityLabel={`${label} diagnostics`} accessibilityState={{ selected: id === tab }} onPress={() => setTab(id)}
          style={[styles.tab, id === tab && styles.selectedTab]}><Text style={[styles.tabText, id === tab && styles.selectedTabText]}>{label}</Text></Pressable>)}
    </View>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {previewStatus && <Text accessibilityLiveRegion="polite" style={styles.previewStatus}>{`Gap detection: ${previewStatus}`}</Text>}
      {tab === "overview" && <>
        <View style={styles.stats}>
          {([['Vehicles', inference?.vehicles.length ?? analysis?.vehicle_count ?? 0, '#111111'],
            ['Openings', gaps.length, '#111111'], ['Signs', signCount, '#111111']] as const).map(([label, value, color]) =>
            <View key={label} style={styles.stat}><Text style={[styles.statValue, { color }]}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open gap details" onPress={() => setTab("gaps")} style={styles.summaryRow}>
          <View style={[styles.dot, { backgroundColor: "#111111" }]} /><Text style={styles.summaryText}>{gapState}</Text><Text style={styles.chevron}>↗</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open sign details" onPress={() => setTab("signs")} style={styles.summaryRow}>
          <View style={[styles.dot, { backgroundColor: "#111111" }]} />
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
              <Text style={[styles.stateBadge, { color: "#555555" }]}>{gap?.confirmed ? "CONFIRMED" : "CANDIDATE"}</Text></View>
            <Text style={styles.detail}>{`${Math.round(bbox[2] - bbox[0])} px wide · ${gap ? `${gap.duration.toFixed(1)}s observed` : "Acquiring tracks"}${gap?.median_width_meters != null ? ` · ${gap.median_width_meters.toFixed(1)} m` : ""}`}</Text>
            <Text style={styles.secondary}>{boundary}</Text>
          </View>;
        })}
        <Text style={styles.caption}>Measurements are in image pixels. A detected gap does not verify vehicle fit or curb legality.</Text>
      </>}
      {tab === "signs" && <>
        <Text style={styles.sectionSummary}>{fresh && current.length ? "Sign reading" : signs.length ? "Last sign reading" : "Sign reading"}</Text>
        {!signs.length && <Text style={styles.secondary}>{signCount ? "Sign detected — waiting for server reading feedback" : "No sign detected. Point the camera at a parking sign."}</Text>}
        {signs.map((sign) => <View key={sign.track_id} style={styles.signCard}>
          <View style={styles.cardHeading}><Text style={styles.signTitle}>{`SIGN ${String(sign.track_id).padStart(2, '0')}`}</Text>
            <Text style={[styles.stateBadge, { color: "#555555" }]}>{sign.state === "gathering" ? `${sign.observations}/${sign.required_observations} VIEWS`
              : sign.state === "unavailable" ? "UNAVAILABLE" : sign.state === "uncertain" ? "NEEDS REVIEW" : isParkingReading(sign) ? "RULE READ" : "INFORMATIONAL"}</Text></View>
          {sign.state === "unavailable" && <Text style={styles.secondary}>Reading unavailable — server API key missing</Text>}
          {sign.reading && <>
            <Text style={styles.rawLabel}>Text on sign</Text>
            <Text selectable style={styles.raw}>{sign.reading.signs.map((item) => item.raw_text).filter(Boolean).join("\n\n") || "No sign text extracted"}</Text>
            <Text style={styles.rawLabel}>Interpretation</Text>
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
    {deliveryText && <View style={styles.receipt}><Text style={styles.receiptText}>{deliveryText}</Text>
      {!!deliveryDetail && <Text style={styles.receiptDetail}>{deliveryDetail}</Text>}</View>}
  </View>;
}

const styles = StyleSheet.create({
  previewStatus: { fontFamily: font.semibold, fontSize: 12, lineHeight: 18, color: "#333333" },
  credits: { paddingHorizontal: 20, paddingBottom: 8, paddingTop: 4 },
  creditText: { fontFamily: font.regular, fontSize: 9, color: "#737373" },
  panel: { position: "absolute", left: 18, right: 18, bottom: 108, maxHeight: "46%", borderRadius: 18, borderCurve: "continuous",
    borderWidth: 0.5, borderColor: "rgba(0,0,0,0.08)", backgroundColor: "#FFFFFF", overflow: "hidden" },
  heading: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eyebrow: { fontFamily: font.bold, fontSize: 19, letterSpacing: -0.5, color: "#111111" },
  connection: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  connectionText: { fontFamily: font.regular, fontSize: 10, color: "#737373" },
  tabs: { flexDirection: "row", marginHorizontal: 20, borderBottomWidth: 1, borderBottomColor: "#EBEBEB" },
  tab: { flex: 1, minHeight: 44, borderBottomWidth: 2, borderBottomColor: "transparent", alignItems: "center", justifyContent: "center" },
  selectedTab: { borderBottomColor: "#111111" },
  tabText: { fontFamily: font.regular, fontSize: 13, color: "#737373" },
  selectedTabText: { fontFamily: font.semibold, color: "#111111" },
  scroll: { flexShrink: 1, flexGrow: 0 },
  content: { paddingHorizontal: 20, paddingVertical: 15, gap: 12 },
  stats: { flexDirection: "row", paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: "#EBEBEB" },
  stat: { flex: 1, gap: 4 },
  statValue: { fontFamily: font.semibold, fontSize: 30, lineHeight: 32, fontVariant: ["tabular-nums"] },
  statLabel: { fontFamily: font.regular, fontSize: 11, color: "#737373" },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 36 },
  summaryText: { flex: 1, fontFamily: font.regular, fontSize: 12, lineHeight: 18, color: "#262626" },
  chevron: { color: "#737373", fontSize: 14 },
  sectionSummary: { fontFamily: font.regular, fontSize: 11, color: "#737373" },
  gapCard: { borderTopWidth: 1, borderTopColor: "#EBEBEB", paddingTop: 14, paddingBottom: 4, gap: 8 },
  signCard: { gap: 9 },
  cardHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "#EBEBEB" },
  gapTitle: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.8, color: "#111111" },
  signTitle: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.8, color: "#111111" },
  stateBadge: { fontFamily: font.regular, fontSize: 9, letterSpacing: 0.5 },
  detail: { fontFamily: font.regular, fontSize: 12, lineHeight: 19, color: "#333333" },
  secondary: { fontFamily: font.regular, fontSize: 10, lineHeight: 16, color: "#737373" },
  rawLabel: { fontFamily: font.regular, fontSize: 10, color: "#737373", marginTop: 2 },
  raw: { fontFamily: font.semibold, fontSize: 14, lineHeight: 22, color: "#111111" },
  caption: { fontFamily: font.regular, fontSize: 10, lineHeight: 16, color: "#737373" },
  receipt: { paddingHorizontal: 20, paddingVertical: 10, gap: 3, borderTopWidth: 1, borderTopColor: "#EBEBEB", backgroundColor: "#FAFAFA" },
  receiptText: { fontFamily: font.regular, fontSize: 10, color: "#555555" },
  receiptDetail: { fontFamily: font.regular, fontSize: 9, color: "#737373" },
});
