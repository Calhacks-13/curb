import { SymbolView } from "expo-symbols";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { SpaceDetail } from "@/api/types";
import { font, ink, radius } from "@/config/tokens";
import { formatAge } from "@/features/find/freshness";
import { formatDistance, walkMinutes, type FindOption } from "@/features/find/options";
import type { DetailLoad } from "@/features/find/useSpaceDetail";
import { formatLaClock } from "@/lib/laTime";

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

function RuleRows({ detail }: { detail: SpaceDetail }) {
  const rule = detail.rule;
  if (!rule) return <Text style={styles.muted}>No validated rule for this curb.</Text>;
  const rows: [string, string][] = [];
  if (rule.max_minutes) rows.push(["Max stay", formatMinutes(rule.max_minutes)]);
  if (rule.next_change_at) {
    rows.push(["Changes at", `${formatLaClock(rule.next_change_at)}${rule.next_change_summary ? ` · ${rule.next_change_summary}` : ""}`]);
  }
  if (rule.payment_text) rows.push(["Payment", rule.payment_text]);
  if (rule.permit_text) rows.push(["Permit", rule.permit_text]);
  return (
    <View style={styles.ruleCard}>
      <Text style={styles.ruleSummary}>{rule.summary}</Text>
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
  const confidence = load.status === "ready" ? Math.round(load.detail.space.base_confidence * 100) : null;
  return (
    <View>
      <View style={styles.header}>
        <OptionChip kind={option.kind} size={20} />
        <Text style={styles.title} accessibilityRole="header">
          {option.title}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close details" hitSlop={10} style={styles.close}>
          <SymbolView name="xmark" size={13} weight="bold" tintColor={ink.black} fallback={<Text style={styles.closeText}>x</Text>} />
        </Pressable>
      </View>

      <Text style={styles.meta} accessibilityLiveRegion="polite">
        Seen {formatAge(ageSeconds)}
        {confidence != null ? ` · ${confidence}% confidence` : ""} · {formatDistance(option.distanceM)}, {walkMinutes(option.distanceM)} min walk
      </Text>

      {load.status === "loading" && (
        <View style={styles.loading}>
          <ActivityIndicator color={ink.black} />
          <Text style={styles.muted}>Reading the curb rules</Text>
        </View>
      )}
      {load.status === "error" && (
        <View style={styles.loading}>
          <Text style={styles.muted}>Couldn&apos;t load the rules for this curb.</Text>
          <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      )}
      {load.status === "ready" && <RuleRows detail={load.detail} />}

      <Text style={styles.disclaimer}>Curb spots aren&apos;t reserved. It can be taken before you arrive.</Text>

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
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 4, marginTop: 2 },
  title: { flex: 1, fontFamily: font.bold, fontSize: 20, color: ink.black, marginTop: 3 },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  closeText: { fontFamily: font.bold, fontSize: 13, color: ink.black },
  meta: { fontFamily: font.regular, fontSize: 13, color: ink.grey500, marginHorizontal: 4, marginTop: 4 },
  ruleCard: { marginTop: 12, padding: 12, borderRadius: radius.button, backgroundColor: ink.grey100, gap: 6 },
  ruleSummary: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: ink.black, marginBottom: 2 },
  ruleRow: { flexDirection: "row", gap: 8 },
  ruleKey: { width: 82, fontFamily: font.regular, fontSize: 13, color: ink.grey500 },
  ruleValue: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: ink.black },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, marginHorizontal: 4 },
  muted: { fontFamily: font.regular, fontSize: 14, color: ink.grey500 },
  link: { fontFamily: font.bold, fontSize: 14, color: ink.black, textDecorationLine: "underline" },
  disclaimer: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, marginTop: 10, marginHorizontal: 4 },
  cta: {
    marginTop: 10,
    height: 52,
    borderRadius: radius.control,
    backgroundColor: ink.black,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: { fontFamily: font.bold, fontSize: 17, color: ink.white, marginTop: 3 },
});
