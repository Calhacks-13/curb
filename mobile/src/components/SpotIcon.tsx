import { SymbolView } from "expo-symbols";
import { StyleSheet, Text, View } from "react-native";

import { font, ink, status } from "@/config/tokens";
import type { SpotKind } from "@/data/spots";

/** Row icon: a light tile holding the same status chip as the map callout. */
export function SpotIcon({ kind }: { kind: SpotKind }) {
  return (
    <View style={styles.tile}>
      {kind === "street" && (
        <View style={[styles.chip, { backgroundColor: status.open }]}>
          <Text style={styles.p}>P</Text>
        </View>
      )}
      {kind === "likely" && <View style={styles.dashRing} />}
      {kind === "driveway" && (
        <View style={[styles.chip, { backgroundColor: status.driveway }]}>
          <SymbolView name="lock.fill" size={11} tintColor={ink.white} fallback={<Text style={styles.p}>$</Text>} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 40, height: 40, borderRadius: 10, backgroundColor: ink.grey100, alignItems: "center", justifyContent: "center" },
  chip: { width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  dashRing: { width: 16, height: 16, borderRadius: 8, borderWidth: 2.5, borderStyle: "dashed", borderColor: status.open },
  p: { fontFamily: font.extrabold, fontSize: 13, color: ink.white, marginTop: 3 },
});
