import React, { useState } from "react";
import { Alert, Text, View } from "react-native";
import { message, type Contact, type Settings } from "../api";
import { useCrashAlert } from "../crash";
import { useSession } from "../session";
import { C } from "../theme";
import { Btn, Card, Chip, Notice, Screen, SwitchRow } from "../ui";

const LEVELS = ["Baja", "Media", "Alta"] as const;

export function Profile({ bleEnabled, onBleChange }: { bleEnabled: boolean; onBleChange: (v: boolean) => void }) {
  const { user, url, api, saveSettings, logout } = useSession();
  const crash = useCrashAlert();
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  if (!user) return null;

  async function set(patch: Partial<Settings>) {
    setErr(""); setInfo("");
    try { await saveSettings(patch); } catch (e) { setErr(message(e)); }
  }

  async function demo() {
    setErr(""); setInfo("");
    try {
      const r = await api<{ seeded: boolean }>("POST", "/demo/seed");
      setInfo(r.seeded ? "Listo: cargamos recorridos y contactos de ejemplo." : "Esta cuenta ya tiene datos; no se agregó nada.");
      void api<Contact[]>("GET", "/contacts").catch(() => {});
    } catch (e) { setErr(message(e)); }
  }

  return (
    <Screen title="Perfil">
      <Card>
        <Text style={{ fontSize: 20, fontWeight: "800", color: C.ink }}>{user.name}</Text>
        <Text style={{ color: C.sub }}>{user.email}</Text>
      </Card>

      <Card>
        <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>Casco</Text>
        <SwitchRow label="Conectar casco por Bluetooth" value={bleEnabled} onValueChange={onBleChange}
          hint="Pide permiso de Bluetooth y busca tu casco SafeRide cerca." />
        <Text style={{ fontWeight: "600", color: C.ink }}>Sensibilidad de detección</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {LEVELS.map((l, i) => (
            <Chip key={l} label={l} selected={user.settings.sensitivity === i}
              onPress={() => { void set({ sensitivity: i as 0 | 1 | 2 }); void crash.setSensitivity(i as 0 | 1 | 2); }} />
          ))}
        </View>
      </Card>

      <Card>
        <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>Alertas</Text>
        <SwitchRow label="Sirena en el teléfono" hint="Suena cuando hay una alerta de choque." value={user.settings.phone_sound}
          onValueChange={(v) => set({ phone_sound: v })} />
        <SwitchRow label="Alarma del casco" hint="Preferencia guardada en tu cuenta." value={user.settings.buzzer}
          onValueChange={(v) => set({ buzzer: v })} />
      </Card>

      {!!err && <Notice tone="danger" text={err} />}
      {!!info && <Notice tone="ok" text={info} />}

      <Card>
        <Btn kind="secondary" label="Cargar datos de demostración" onPress={demo} />
        <Btn kind="danger" label="Cerrar sesión" onPress={() =>
          Alert.alert("Cerrar sesión", "¿Quieres salir de tu cuenta?", [
            { text: "Cancelar", style: "cancel" }, { text: "Salir", style: "destructive", onPress: () => void logout() },
          ])} />
        <Text style={{ color: C.sub, fontSize: 12 }}>Servidor: {url}</Text>
      </Card>
    </Screen>
  );
}
