import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { font, ink, radius, shadow } from "@/config/tokens";

type Props = {
  destination: string;
  arrivalLabel: string;
  onPressSearch?: () => void;
  onPressAccount?: () => void;
};

export function SearchBar({ destination, arrivalLabel, onPressSearch, onPressAccount }: Props) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPressSearch}
        accessibilityRole="search"
        accessibilityLabel={`Destination ${destination}. ${arrivalLabel}`}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
      >
        <View style={styles.destSquare} />
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
            {destination}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {arrivalLabel}
          </Text>
        </View>
      </Pressable>
      <Pressable
        onPress={onPressAccount}
        accessibilityRole="button"
        accessibilityLabel="Account"
        style={({ pressed }) => [styles.account, pressed && styles.pressed]}
      >
        <SymbolView name="person.fill" size={20} tintColor={ink.black} fallback={<View style={styles.avatarFallback} />} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  pill: {
    flex: 1,
    height: 50,
    borderRadius: radius.pill,
    backgroundColor: ink.white,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    gap: 12,
    ...shadow.floating,
  },
  pressed: { opacity: 0.85 },
  destSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: ink.black },
  textCol: { flex: 1 },
  title: { fontFamily: font.bold, fontSize: 15, color: ink.black, marginTop: 3 },
  sub: { fontFamily: font.regular, fontSize: 12, color: ink.grey500 },
  account: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: ink.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.floating,
  },
  avatarFallback: { width: 20, height: 20, borderRadius: 10, backgroundColor: ink.black },
});
