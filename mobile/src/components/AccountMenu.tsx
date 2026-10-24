import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";
import { useSession } from "@/features/session/SessionContext";

import { AccountButton } from "./AccountButton";

/** Account control with profile switching for the seeded demo profiles. */
export function AccountMenu() {
  const { session, start, signOut, starting } = useSession();
  const [open, setOpen] = useState(false);
  if (!session) return null;

  const isOwner = session.user.demo_profile === "owner";
  const other = isOwner ? "driver" : "owner";

  const switchProfile = async () => {
    if (await start(other)) {
      setOpen(false);
      router.navigate(other === "owner" ? "/host" : "/find");
    }
  };

  const chooseProfile = async () => {
    setOpen(false);
    await signOut();
    router.replace("/");
  };

  return (
    <View style={styles.wrap}>
      <AccountButton onPress={() => setOpen((o) => !o)} label={`Account, ${session.user.display_name}`} />
      {open && (
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.name}>{session.user.display_name}</Text>
          <Text style={styles.caption}>Demo profile</Text>
          <Pressable onPress={switchProfile} disabled={starting} accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}>
            {starting ? (
              <ActivityIndicator color={ink.white} />
            ) : (
              <Text style={styles.primaryText}>Switch to {isOwner ? "driver" : "driveway owner"}</Text>
            )}
          </Pressable>
          <Pressable onPress={chooseProfile} accessibilityRole="button" style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}>
            <Text style={styles.secondaryText}>Choose profile</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end", zIndex: 10 },
  card: {
    position: "absolute",
    top: 52,
    right: 0,
    width: 236,
    padding: 14,
    gap: 6,
    borderRadius: radius.button,
    backgroundColor: ink.white,
    ...shadow.floating,
  },
  name: { fontFamily: font.bold, fontSize: 16, color: ink.black, marginTop: 2 },
  caption: { fontFamily: font.regular, fontSize: 12, color: ink.grey500, marginBottom: 6 },
  primary: { height: 44, borderRadius: radius.control, backgroundColor: ink.black, alignItems: "center", justifyContent: "center" },
  primaryText: { fontFamily: font.bold, fontSize: 14, color: ink.white, marginTop: 2 },
  secondary: { height: 40, borderRadius: radius.control, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontFamily: font.bold, fontSize: 14, color: ink.black, marginTop: 2 },
});
