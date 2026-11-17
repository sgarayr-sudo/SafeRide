import React from "react";
import { Modal, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import type { ActiveAlert } from "./CrashAlertProvider";

interface Props {
  alert: ActiveAlert | null;
  remainingS: number;
  totalS: number;
  onImOk(): void;
  onAskForHelp(): void;
}

const RED = "#9F1414";
const RED_DARK = "#6E0B0B";

/** Pantalla de emergencia: texto grande, alto contraste y dos acciones muy claras. */
export function CrashAlertOverlay({ alert, remainingS, totalS, onImOk, onAskForHelp }: Props) {
  if (!alert) return null;
  const sending = alert.phase === "sending";
  const who =
    alert.source === "helmet"
      ? `Detectado por tu casco${alert.peakG ? ` · ${alert.peakG.toFixed(1)} g` : ""}`
      : "Alerta simulada desde el teléfono";
  const pct = Math.max(0, Math.min(1, remainingS / totalS));

  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => { /* no se puede cerrar con «atrás» */ }}>
      <StatusBar barStyle="light-content" backgroundColor={RED} />
      <View style={styles.root} accessibilityViewIsModal>
        <View style={styles.top}>
          <Text style={styles.title} accessibilityRole="header">
            Posible choque
          </Text>
          <Text style={styles.sub}>{who}</Text>
        </View>

        <View style={styles.middle}>
          <Text
            style={styles.count}
            accessibilityLiveRegion="polite"
            accessibilityLabel={`Avisaremos a tus contactos en ${remainingS} segundos`}
          >
            {sending ? "…" : remainingS}
          </Text>
          <Text style={styles.hint}>
            {sending ? "Registrando tu respuesta" : "segundos para avisar a tus contactos"}
          </Text>
          <View style={styles.track} accessible={false}>
            <View style={[styles.fill, { width: `${pct * 100}%` }]} />
          </View>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={onImOk}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Estoy bien. Cancela la alerta"
            style={({ pressed }) => [styles.ok, pressed && styles.pressed, sending && styles.disabled]}
          >
            <Text style={styles.okText}>Estoy bien</Text>
          </Pressable>
          <Pressable
            onPress={onAskForHelp}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Pedir ayuda ahora. Avisa a tus contactos sin esperar"
            style={({ pressed }) => [styles.help, pressed && styles.pressed, sending && styles.disabled]}
          >
            <Text style={styles.helpText}>Pedir ayuda ahora</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: RED, paddingHorizontal: 24, paddingVertical: 48, justifyContent: "space-between" },
  top: { gap: 6 },
  title: { color: "#fff", fontSize: 34, fontWeight: "800" },
  sub: { color: "#FFD9D9", fontSize: 17 },
  middle: { alignItems: "center", gap: 10 },
  count: { color: "#fff", fontSize: 140, fontWeight: "800", fontVariant: ["tabular-nums"], lineHeight: 156 },
  hint: { color: "#FFD9D9", fontSize: 18, textAlign: "center" },
  track: { alignSelf: "stretch", height: 8, borderRadius: 4, backgroundColor: RED_DARK, overflow: "hidden", marginTop: 8 },
  fill: { height: 8, backgroundColor: "#fff" },
  actions: { gap: 14 },
  ok: { backgroundColor: "#fff", minHeight: 76, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  okText: { color: RED, fontSize: 26, fontWeight: "800" },
  help: { minHeight: 64, borderRadius: 16, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  helpText: { color: "#fff", fontSize: 20, fontWeight: "700" },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
});
