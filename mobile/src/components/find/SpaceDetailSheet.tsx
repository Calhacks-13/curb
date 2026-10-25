import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { SpaceDetail } from "@/api/types";
import { font, ink, radius, SEP, status } from "@/config/tokens";
import { formatAge } from "@/features/find/freshness";
import type { FindOption } from "@/features/find/options";
import type { DetailLoad } from "@/features/find/useSpaceDetail";
import { formatLaChange } from "@/lib/laTime";

type Props = {
  option: FindOption;
  ageSeconds: number;
  /** The same age-adjusted whole percentage the map pill and nearby row show. */
  confidencePercent: number;
  /** Vehicle-detection confidence (0 through 1) from the live space record. */
  detectionConfidence: number;
  load: DetailLoad;
  routing: boolean;
  onRoute: () => void;
  onClose: () => void;
  onRetry: () => void;
};

/** Formats a rule's maximum stay, e.g. "2 hr" or "1 hr 30 min". */
function formatMinutes(min: number): string {
  if (min % 60 === 0) return `${min / 60} hr`;
  return min > 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
}

/** Spoken observation age for screen readers, e.g. "18 seconds ago". */
function spokenAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "not observed";
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `${s} ${s === 1 ? "second" : "seconds"} ago`;
  }
  const m = Math.floor(seconds / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
}

/** Formats a 0-to-1 fraction as a whole percentage, or an em dash when unknown. */
function percentText(fraction: number | null | undefined): string {
  return fraction == null || !Number.isFinite(fraction) ? "—" : `${Math.round(fraction * 100)}%`;
}

/** Parking-rule confidence, only once a non-blank rule has loaded. */
function ruleConfidence(load: DetailLoad): number | null {
  if (load.status !== "ready" || isBlankRule(load.detail.rule)) return null;
  return load.detail.rule?.interpretation_confidence ?? null;
}

/** One supporting fact row with a complete accessibility label. */
function FactRow({ label, value, spoken }: { label: string; value: string; spoken?: string }) {
  return (
    <View style={styles.factRow} accessible accessibilityLabel={`${label}: ${spoken ?? value}`}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

/** True when the backend sent a rule object with nothing read off the sign yet. */
export function isBlankRule(rule: SpaceDetail["rule"]): boolean {
  if (!rule) return true;
  return !rule.summary?.trim() && !rule.max_minutes && !rule.next_change_at && !rule.payment_text && !rule.permit_text;
}

function RuleCard({ detail }: { detail: SpaceDetail }) {
  const rule = detail.rule;
  if (!rule || isBlankRule(rule))
    return (
      <View style={styles.ruleCard}>
        <Text style={styles.ruleSummary}>No sign read for this curb yet</Text>
        <Text style={styles.muted}>Check the posted signs before you park.</Text>
      </View>
    );
  const rows: [string, string][] = [];
  if (rule.max_minutes) rows.push(["Max stay", formatMinutes(rule.max_minutes)]);
  if (rule.next_change_at) {
    const at = formatLaChange(rule.next_change_at);
    if (at) rows.push(["Next rule change", rule.next_change_summary ? `${at}${SEP}${rule.next_change_summary}` : at]);
  }
  if (rule.payment_text) rows.push(["Payment", rule.payment_text]);
  if (rule.permit_text) rows.push(["Permit", rule.permit_text]);
  return (
    <View style={styles.ruleCard}>
      {!!rule.summary?.trim() && <Text style={styles.ruleSummary}>{rule.summary}</Text>}
      {rows.length > 0 && <View style={styles.divider} />}
      {rows.map(([k, v]) => (
        <View key={k} style={styles.ruleRow}>
          <Text style={styles.ruleKey}>{k}</Text>
          <Text style={styles.ruleValue}>{v}</Text>
        </View>
      ))}
    </View>
  );
}

/** Opens before any route is drawn: how sure we are the spot is open, the evidence, and the rules. */
export function SpaceDetailSheet({ option, ageSeconds, confidencePercent, detectionConfidence, load, routing, onRoute, onClose, onRetry }: Props) {
  const percent = Math.max(0, Math.min(100, confidencePercent));
  const meterColor = option.kind === "driveway" ? ink.black : status[option.kind];
  return (
    <View>
      <View style={styles.header}>
        <View
          style={styles.scoreBlock}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`Chance the spot is open: ${percent} percent`}
        >
          <Text style={styles.eyebrow}>Chance the spot is open</Text>
          <Text style={styles.score}>
            {percent}
            <Text style={styles.scoreUnit}>%</Text>
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close details" hitSlop={10} style={styles.close}>
          <SymbolView name="xmark" size={12} weight="bold" tintColor={ink.black} fallback={<Text style={styles.closeText}>x</Text>} />
        </Pressable>
      </View>

      <View style={styles.meter} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={[styles.meterFill, { width: `${percent}%`, backgroundColor: meterColor }]} />
      </View>

      <View style={styles.facts}>
        <FactRow label="Last observed" value={formatAge(ageSeconds)} spoken={spokenAge(ageSeconds)} />
        <FactRow label="Detection confidence" value={percentText(detectionConfidence)} />
        <FactRow label="Parking rule confidence" value={percentText(ruleConfidence(load))} />
      </View>

      {load.status === "loading" && (
        <View style={[styles.ruleCard, styles.inline]}>
          <ActivityIndicator color={ink.black} />
          <Text style={styles.muted}>Reading the curb rules</Text>
        </View>
      )}
      {load.status === "error" && (
        <View style={[styles.ruleCard, styles.inline]}>
          <Text style={[styles.muted, styles.flex]}>Couldn&apos;t load the rules for this curb.</Text>
          <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      )}
      {load.status === "ready" && <RuleCard detail={load.detail} />}

      <Text style={styles.disclaimer}>Not reserved. It can be taken before you arrive.</Text>

      <Pressable
        onPress={onRoute}
        disabled={routing}
        accessibilityRole="button"
        accessibilityState={{ busy: routing }}
        style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
      >
        {routing ? <ActivityIndicator color={ink.white} /> : <Text style={styles.ctaText}>Route here</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 4 },
  scoreBlock: { flex: 1 },
  eyebrow: { fontFamily: font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.6, textTransform: "uppercase", color: ink.grey500, paddingTop: 2 },
  score: { fontFamily: font.extrabold, fontSize: 48, lineHeight: 54, color: ink.black, paddingTop: 6 },
  scoreUnit: { fontFamily: font.bold, fontSize: 20 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  closeText: { fontFamily: font.bold, fontSize: 13, color: ink.black },

  meter: { height: 7, borderRadius: 4, backgroundColor: ink.grey100, overflow: "hidden", marginTop: 6, marginHorizontal: 4 },
  meterFill: { height: "100%", borderRadius: 4 },

  facts: { marginTop: 10, marginBottom: 4, paddingHorizontal: 4 },
  factRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ink.grey300,
  },
  factLabel: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: ink.grey500, paddingTop: 1 },
  factValue: { fontFamily: font.bold, fontSize: 14, lineHeight: 19, color: ink.black, paddingTop: 1 },

  ruleCard: { marginTop: 8, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.button, backgroundColor: ink.grey100 },
  inline: { flexDirection: "row", alignItems: "center", gap: 10 },
  ruleSummary: { fontFamily: font.semibold, fontSize: 15, lineHeight: 21, color: ink.black, paddingTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: ink.grey300, marginVertical: 10 },
  ruleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 16, paddingVertical: 4 },
  ruleKey: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: ink.grey500, paddingTop: 1 },
  ruleValue: { flex: 1, fontFamily: font.semibold, fontSize: 14, lineHeight: 19, color: ink.black, textAlign: "right", paddingTop: 1 },

  muted: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: ink.grey500, paddingTop: 1 },
  flex: { flex: 1 },
  link: { fontFamily: font.bold, fontSize: 14, color: ink.black, textDecorationLine: "underline" },
  disclaimer: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: ink.grey500, marginTop: 10, paddingHorizontal: 4, textAlign: "center" },
  cta: {
    marginTop: 10,
    height: 52,
    borderRadius: radius.control,
    backgroundColor: ink.black,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: { fontFamily: font.bold, fontSize: 17, lineHeight: 22, color: ink.white, paddingTop: 3 },
});
