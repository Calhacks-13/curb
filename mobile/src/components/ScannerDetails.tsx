import { ScrollView, StyleSheet, Text, View } from "react-native";

import type { FrameAccepted, SignFeedback } from "@/api/types";
import { font, ink } from "@/config/tokens";
import type { DeepReadonly } from "@/features/capture/DetectionUploadController";

type Props = {
  analysis: DeepReadonly<FrameAccepted> | null;
  lastSigns: DeepReadonly<SignFeedback[]>;
  signCount: number;
  fresh: boolean;
};

/** Expanded camera details stay readable without covering the whole preview. */
export function ScannerDetails({ analysis, lastSigns, signCount, fresh }: Props) {
  const current = analysis?.sign_feedback ?? [];
  const signs = current.length ? current : lastSigns;
  const confirmed = analysis?.gap_bboxes?.filter((bbox) => analysis.tracked_gaps?.some(
    (gap) => gap.confirmed && gap.bbox.every((value, axis) => value === bbox[axis]),
  )).length ?? 0;
  return (
    <ScrollView style={styles.panel} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Gap analysis</Text>
      <Text style={styles.text}>
        {!analysis ? "Waiting for server gap analysis"
          : analysis.gap_bboxes === undefined ? "Restart the API to enable gap details"
            : !fresh ? "Analysis delayed — gap overlay hidden"
              : `${analysis.gap_bboxes.length} gap${analysis.gap_bboxes.length === 1 ? "" : "s"} · ${confirmed} confirmed`}
      </Text>
      <Text style={styles.text}>Last server sample · Blue dashed: candidate · Blue solid: confirmed. Pixel widths do not establish vehicle fit or parking legality.</Text>
      {fresh && analysis?.gap_bboxes?.map((bbox, index) => {
        const gap = analysis.tracked_gaps?.find((item) => item.bbox.every((value, axis) => value === bbox[axis]));
        const boundary = gap ? `${gap.left_track_id < 0 ? "frame edge" : `vehicle #${gap.left_track_id}`} → ${gap.right_track_id < 0 ? "frame edge" : `vehicle #${gap.right_track_id}`}` : "Waiting for stable vehicle tracks";
        return <Text key={index} style={styles.text}>{`Gap ${index + 1}: ${Math.round(bbox[2] - bbox[0])} px · ${gap ? `${gap.duration.toFixed(1)}s observed · ${gap.confirmed ? "Confirmed" : "Tracking"}` : "Candidate"}\n${boundary}${gap?.median_width_meters != null ? ` · ${gap.median_width_meters.toFixed(1)} m` : " · Meter estimate unavailable"}`}</Text>;
      })}
      <Text style={styles.title}>{current.length ? "Sign reading" : signs.length ? "Last sign reading" : "Sign reading"}</Text>
      {!signs.length && <Text style={styles.text}>{signCount ? "Sign detected — waiting for server reading feedback" : "No sign detected. Point the camera at a parking sign."}</Text>}
      {signs.map((sign) => (
        <View key={sign.track_id} style={styles.sign}>
          <Text style={styles.text}>{`Sign #${sign.track_id} · ${sign.state === "gathering" ? `Gathering views (${sign.observations}/${sign.required_observations})` : sign.state === "unavailable" ? "Reading unavailable — server API key missing" : sign.state === "uncertain" ? "Read needs review" : "Read complete"}`}</Text>
          {sign.reading && <>
            <Text selectable style={styles.text}>{sign.reading.combined_summary || "No readable summary returned"}</Text>
            <Text selectable style={styles.raw}>{sign.reading.signs.map((item) => item.raw_text).filter(Boolean).join("\n\n") || "No sign text extracted"}</Text>
            <Text style={styles.text}>{[
              sign.reading.combined_hours,
              sign.reading.combined_max_duration_min != null ? `${sign.reading.combined_max_duration_min} min limit` : null,
              sign.reading.combined_price,
              ...sign.reading.combined_restrictions,
              `Reading score ${Math.round(sign.reading.confidence_score * 100)}%${sign.reading.flagged ? " · Needs review" : ""}`,
            ].filter(Boolean).join(" · ")}</Text>
          </>}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { position: "absolute", left: 18, right: 18, bottom: 125, maxHeight: "36%", borderRadius: 12, backgroundColor: "rgba(0,0,0,0.82)" },
  content: { padding: 12, gap: 6 },
  title: { fontFamily: font.bold, fontSize: 14, color: ink.white },
  text: { fontFamily: font.regular, fontSize: 12, color: ink.grey300 },
  raw: { fontFamily: font.semibold, fontSize: 14, color: "#FFD166" },
  sign: { gap: 5, paddingTop: 6 },
});
