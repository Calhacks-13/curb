import { Slot } from "expo-router";
import { Text } from "react-native";

import ProfilePicker from "@/app/index";
import { SessionProvider } from "@/features/session/SessionContext";

/** Minimal route tree around the real picker; tabs are stubbed with labels. */
export const sessionRoutes = {
  _layout: () => (
    <SessionProvider>
      <Slot />
    </SessionProvider>
  ),
  index: ProfilePicker,
  "(tabs)/_layout": () => <Slot />,
  "(tabs)/find": () => <Text>Find screen</Text>,
  "(tabs)/host": () => <Text>Host screen</Text>,
};
