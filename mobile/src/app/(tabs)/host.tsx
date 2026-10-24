import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AccountMenu } from "@/components/AccountMenu";
import { font, ink, radius } from "@/config/tokens";
import { DemoModeBadge } from "@/demo/DemoModeBadge";
import { getApi } from "@/api/client";
import { useParkingState } from "@/features/find/useParkingState";
import { DrivewayEditor } from "@/features/host/DrivewayEditor";
import { confirmedBooking, ownedDriveway } from "@/features/host/useDriveway";
import { useSession } from "@/features/session/SessionContext";
import { HOME_CAMERA } from "@/map/mapConfig";

/** Host tab. The seeded owner manages one driveway; drivers see how hosting works. */
export default function HostScreen() {
  const insets = useSafeAreaInsets();
  const { session, start } = useSession();
  const isOwner = session?.user.demo_profile === "owner";
  const { state, load, refresh } = useParkingState(HOME_CAMERA.center);
  const driveway = isOwner ? ownedDriveway(state, session?.user.id ?? null) : null;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} accessibilityRole="header">
            Host
          </Text>
          {getApi().mode === "demo" && <DemoModeBadge />}
        </View>
        <AccountMenu />
      </View>

      {isOwner ? (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {driveway ? (
            <DrivewayEditor driveway={driveway} booking={confirmedBooking(state, driveway.id)} onConflict={refresh} />
          ) : load === "loading" ? (
            <View style={styles.state}>
              <ActivityIndicator color={ink.black} />
              <Text style={styles.cardText}>Loading your listing</Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{load === "error" ? "Can't reach Curb right now" : "No listing yet"}</Text>
              <Text style={styles.cardText}>
                {load === "error" ? "Your listing will appear as soon as we reconnect." : "The demo owner's driveway isn't seeded on this server."}
              </Text>
              {load === "error" && (
                <Pressable onPress={refresh} accessibilityRole="button" style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}>
                  <Text style={styles.ctaText}>Try again</Text>
                </Pressable>
              )}
            </View>
          )}
        </ScrollView>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Earn from your driveway</Text>
          <Text style={styles.cardText}>
            Owners list a driveway, set a price and a window, and drivers pay to reserve it. The demo has one seeded owner.
          </Text>
          <Pressable
            onPress={async () => {
              if (await start("owner")) router.navigate("/host");
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.ctaText}>Switch to driveway owner</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ink.white, paddingHorizontal: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, zIndex: 10 },
  headerText: { gap: 8 },
  title: { fontFamily: font.extrabold, fontSize: 32, color: ink.black, marginTop: 4 },
  scroll: { paddingBottom: 24 },
  state: { alignItems: "center", gap: 8, paddingVertical: 32 },
  card: { padding: 16, borderRadius: radius.sheet, backgroundColor: ink.grey100, gap: 6 },
  cardTitle: { fontFamily: font.bold, fontSize: 18, color: ink.black, marginTop: 2 },
  cardText: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: ink.grey700 },
  cta: { marginTop: 10, height: 48, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  ctaText: { fontFamily: font.bold, fontSize: 15, color: ink.white, marginTop: 2 },
});
