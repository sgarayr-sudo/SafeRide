import React from "react";
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput,
  type StyleProp, type TextInputProps, type ViewStyle, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { C, R } from "./theme";

export function Screen({ title, subtitle, children, onRefresh, refreshing }: {
  title: string; subtitle?: string; children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean;
}) {
  return (
    <SafeAreaView edges={["top"]} style={s.screen}>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.brand} /> : undefined}
      >
        <Text style={s.h1} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Btn({ label, onPress, kind = "primary", disabled, loading }: {
  label: string; onPress: () => void; kind?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; loading?: boolean;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [s.btn, s[`btn_${kind}`], pressed && { opacity: 0.8 }, off && { opacity: 0.5 }]}
    >
      {loading ? <ActivityIndicator color={kind === "primary" ? "#fff" : C.brand} /> : <Text style={[s.btnText, s[`btnText_${kind}`]]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput {...props} placeholderTextColor={C.sub} style={s.input} accessibilityLabel={label} />
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}
      style={[s.chip, selected && { backgroundColor: C.ink, borderColor: C.ink }]}>
      <Text style={[s.chipText, selected && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

export function SwitchRow({ label, hint, value, onValueChange, disabled }: {
  label: string; hint?: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <View style={s.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} trackColor={{ true: C.brand, false: C.line }} thumbColor="#fff" />
    </View>
  );
}

const TONES = {
  ok: { bg: C.okBg, fg: C.ok }, warn: { bg: C.warnBg, fg: C.warn },
  danger: { bg: C.dangerBg, fg: C.danger }, neutral: { bg: "#EAECF0", fg: "#344054" },
} as const;

export function Pill({ text, tone = "neutral" }: { text: string; tone?: keyof typeof TONES }) {
  return (
    <View style={[s.pill, { backgroundColor: TONES[tone].bg }]}>
      <Text style={[s.pillText, { color: TONES[tone].fg }]}>{text}</Text>
    </View>
  );
}

export function Notice({ text, tone = "warn" }: { text: string; tone?: keyof typeof TONES }) {
  return (
    <View style={[s.notice, { backgroundColor: TONES[tone].bg }]}>
      <Text style={{ color: TONES[tone].fg, fontSize: 14, lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={s.empty}>{text}</Text>;
}

export const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${r} s` : `${r} s`;
};
export const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, gap: 14, paddingBottom: 40 },
  h1: { fontSize: 28, fontWeight: "800", color: C.ink },
  subtitle: { fontSize: 15, color: C.sub, marginTop: -8 },
  card: { backgroundColor: C.card, borderRadius: R, padding: 16, gap: 12, borderWidth: 1, borderColor: C.line },
  btn: { minHeight: 52, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  btn_primary: { backgroundColor: C.brand },
  btn_secondary: { backgroundColor: "#fff", borderWidth: 1.5, borderColor: C.ink },
  btn_danger: { backgroundColor: "#fff", borderWidth: 1.5, borderColor: C.danger },
  btn_ghost: { backgroundColor: "transparent" },
  btnText: { fontSize: 16, fontWeight: "700" },
  btnText_primary: { color: "#fff" }, btnText_secondary: { color: C.ink },
  btnText_danger: { color: C.danger }, btnText_ghost: { color: C.brand },
  label: { fontSize: 14, fontWeight: "600", color: C.ink },
  input: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: "#D0D5DD", backgroundColor: "#fff", paddingHorizontal: 14, fontSize: 16, color: C.ink },
  chip: { paddingHorizontal: 14, minHeight: 40, borderRadius: 20, borderWidth: 1, borderColor: "#D0D5DD", justifyContent: "center" },
  chipText: { fontSize: 14, color: C.ink, fontWeight: "600" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowTitle: { fontSize: 16, fontWeight: "600", color: C.ink },
  hint: { fontSize: 13, color: C.sub, marginTop: 2 },
  pill: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  pillText: { fontSize: 12, fontWeight: "700" },
  notice: { padding: 12, borderRadius: 12 },
  empty: { textAlign: "center", color: C.sub, paddingVertical: 28, fontSize: 15 },
});
