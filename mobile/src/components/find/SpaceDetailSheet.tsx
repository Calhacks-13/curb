import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { SpaceDetail } from "@/api/types";
import { font, ink, radius, SEP } from "@/config/tokens";
import { formatAgeShort } from "@/features/find/freshness";
import { formatDistance, walkMinutes, type FindOption } from "@/features/find/options";
import type { DetailLoad } from "@/features/find/useSpaceDetail";
import { formatLaClockShort } from "@/lib/laTime";

import { OptionChip } from "../OptionIcon";

type Props = {
  option: FindOption;
  ageSeconds: number;
  load: DetailLoad;
  routing: boolean;
  onRoute: () => void;
  onClose: () => void;
  onRetry: () => void;
};

function formatMinutes(min: number): string {
  if (min % 60 === 0) return `${min / 60} hr`;
  return min > 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function RuleCard({ detail }: { detail: SpaceDetail }) {
  const rule = detail.rule;
  if (!rule) return <Text style={styles.muted}>No validated rule for this curb.</Text>;
  const rows: [string, string][] = [];
  if (rule.max_minutes) rows.push(["Max stay", formatMinutes(rule.max_minutes)]);
  if (rule.next_change_at) {
    const at = formatLaClockShort(rule.next_change_at);
    rows.push(["Changes", rule.next_change_summary ? `${at}${SEP}${rule.next_change_summary}` : at]);
  }
  if (rule.payment_text) rows.push(["Payment", rule.payment_text]);
  if (rule.permit_text) rows.push(["Permit", rule.permit_text]);
  return (
    <View style={styles.ruleCard}>
      <Text style={styles.ruleSummary}>{rule.summary}</Text>
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

/** Opens before any route is drawn: what this spot is, the rules, and how sure we are. */
export function SpaceDetailSheet({ option, ageSeconds, load, routing, onRoute, onClose, onRetry }: Props) {
  const confidence = load.status === "ready" ? `${Math.round(load.detail.space.base_confidence * 100)}%` : "—";
  return (
    <View>
      <View style={styles.header}>
        <OptionChip kind={option.kind} size={24} />
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {option.title}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close details" hitSlop={10} style={styles.close}>
          <SymbolView name="xmark" size={12} weight="bold" tintColor={ink.black} fallback={<Text style={styles.closeText}>x</Text>} />
        </Pressable>
      </View>

      <View style={styles.stats} accessibilityLiveRegion="polite">
        <Stat value={formatAgeShort(ageSeconds)} label="Last seen" />
        <View style={styles.statDivider} />
        <Stat value={confidence} label="Confidence" />
        <View style={styles.statDivider} />
        <Stat value={`${walkMinutes(option.distanceM)} min`} label={`${formatDistance(option.distanceM)} walk`} />
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
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, minHeight: 36 },
  title: { flex: 1, fontFamily: font.bold, fontSize: 20, lineHeight: 26, color: ink.black, paddingTop: 3 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  closeText: { fontFamily: font.bold, fontSize: 13, color: ink.black },

  stats: { flexDirection: "row", alignItems: "center", marginTop: 12, paddingVertical: 10, paddingHorizontal: 4 },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontFamily: font.bold, fontSize: 17, lineHeight: 22, color: ink.black, paddingTop: 2 },
  statLabel: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: ink.grey500 },
  statDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: ink.grey300 },

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
