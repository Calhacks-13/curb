import { Redirect } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { DemoProfile } from "@/api/types";
import { font, ink, radius } from "@/config/tokens";
import { useSession } from "@/features/session/SessionContext";

const PROFILES: { profile: DemoProfile; title: string; detail: string }[] = [
  { profile: "driver", title: "Continue as Driver", detail: "Find curb openings and reserve driveways" },
  { profile: "owner", title: "Continue as Driveway Owner", detail: "Manage your listing and see bookings" },
];

/** One-tap demo profile picker (spec 7.1). Remembers the choice on this device. */
export default function ProfilePicker() {
  const insets = useSafeAreaInsets();
  const { restoring, session, starting, error, start } = useSession();

  if (session) return <Redirect href={session.user.demo_profile === "owner" ? "/host" : "/find"} />;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 }]}>
      <StatusBar style="light" />
      <View style={styles.brand}>
        <Text style={styles.wordmark} accessibilityRole="header">
          Curb
        </Text>
        <Text style={styles.tagline}>Legal parking, seen moments ago.</Text>
      </View>

      {restoring ? (
        <ActivityIndicator color={ink.white} accessibilityLabel="Restoring your demo profile" />
      ) : (
        <View style={styles.choices}>
          {PROFILES.map((p, i) => (
            <Pressable
              key={p.profile}
              onPress={() => start(p.profile)}
              disabled={starting}
              accessibilityRole="button"
              accessibilityLabel={p.title}
              accessibilityHint={p.detail}
              style={({ pressed }) => [styles.choice, i === 0 ? styles.primary : styles.secondary, pressed && { opacity: 0.85 }]}
            >
              <Text style={[styles.choiceTitle, i === 0 ? styles.primaryText : styles.secondaryText]}>{p.title}</Text>
              <Text style={[styles.choiceDetail, i === 0 ? styles.primaryDetail : styles.secondaryDetail]}>{p.detail}</Text>
            </Pressable>
          ))}
          {starting && <ActivityIndicator color={ink.white} style={styles.spinner} />}
          {error && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
          <Text style={styles.footnote}>Demo profiles for the hackathon. No sign-in, no real accounts.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.black, paddingHorizontal: 24, justifyContent: "space-between" },
  brand: { gap: 8 },
  wordmark: { fontFamily: font.extrabold, fontSize: 56, color: ink.white, letterSpacing: -1.5 },
  tagline: { fontFamily: font.regular, fontSize: 18, color: ink.grey300 },
  choices: { gap: 12 },
  choice: { borderRadius: radius.button, paddingHorizontal: 18, paddingVertical: 16 },
  primary: { backgroundColor: ink.white },
  secondary: { borderWidth: 1.5, borderColor: ink.grey700 },
  choiceTitle: { fontFamily: font.bold, fontSize: 17, marginTop: 2 },
  primaryText: { color: ink.black },
  secondaryText: { color: ink.white },
  choiceDetail: { fontFamily: font.regular, fontSize: 13, marginTop: 2 },
  primaryDetail: { color: ink.grey500 },
  secondaryDetail: { color: ink.grey300 },
  spinner: { marginTop: 4 },
  error: { fontFamily: font.semibold, fontSize: 14, color: ink.white, textAlign: "center" },
  footnote: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, textAlign: "center", marginTop: 8 },
});
