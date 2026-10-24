import { Redirect } from "expo-router";
import { Tabs } from "expo-router/tabs";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Text, type ColorValue } from "react-native";

import { font, ink } from "@/config/tokens";
import { useSession } from "@/features/session/SessionContext";

function icon(name: SymbolViewProps["name"], fallback: string) {
  function TabIcon({ color }: { color: ColorValue }) {
    return <SymbolView name={name} size={22} tintColor={color} fallback={<Text style={{ color }}>{fallback}</Text>} />;
  }
  return TabIcon;
}

export default function TabsLayout() {
  const { session, restoring } = useSession();
  if (!session && !restoring) return <Redirect href="/" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ink.black,
        tabBarInactiveTintColor: ink.grey500,
        tabBarStyle: { backgroundColor: ink.white, borderTopColor: ink.grey100 },
        tabBarLabelStyle: { fontFamily: font.semibold, fontSize: 11 },
      }}
    >
      <Tabs.Screen name="find" options={{ title: "Find", tabBarIcon: icon("map.fill", "F") }} />
      <Tabs.Screen name="host" options={{ title: "Host", tabBarIcon: icon("house.fill", "H") }} />
    </Tabs>
  );
}
