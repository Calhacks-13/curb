import {
  Overpass_400Regular,
  Overpass_600SemiBold,
  Overpass_700Bold,
  Overpass_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/overpass";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SessionProvider } from "@/features/session/SessionContext";

SplashScreen.preventAutoHideAsync();

// @gorhom/bottom-sheet still passes dependency arrays to Reanimated hooks; Reanimated 4
// ignores them on native and warns on every render. Harmless, so keep the log readable.
LogBox.ignoreLogs(["[Reanimated] Dependencies should only be used on the web"]);

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Overpass_400Regular,
    Overpass_600SemiBold,
    Overpass_700Bold,
    Overpass_800ExtraBold,
  });

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync();
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false, animation: "fade" }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
