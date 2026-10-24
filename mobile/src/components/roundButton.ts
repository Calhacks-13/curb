import { StyleSheet } from "react-native";

import { ink, shadow } from "@/config/tokens";

/** Round white map button (account, map key). */
export const roundButton = StyleSheet.create({
  base: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: ink.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.floating,
  },
});
