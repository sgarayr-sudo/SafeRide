import * as Location from "expo-location";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { message, type Contact, type Request } from "../api";
import { useCrashAlert, type HelmetState } from "../crash";
import { useSession } from "../session";
import { C } from "../theme";
import { Btn, Card, Notice, Pill, Screen, fmtDuration } from "../ui";

const HELMET_TEXT: Record<HelmetState, string> = {
  unavailable: "Bluetooth no disponible en este teléfono",
  off: "Bluetooth apagado o sin permiso",
  scanning: "Buscando tu casco…",
  connecting: "Conectando con el casco…",
  connected: "Casco conectado",
  disconnected: "Casco desconectado, reconectando…",
};

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

interface Pt { lat: number; lon: number; speed: number; t: number }

function useTrip(api: Request, onTripChange: (id: number | null) => void) {
  const [tripId, setTripId] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [stats, setStats] = useState({ km: 0, kmh: 0, max: 0 });
  const sub = useRef<Location.LocationSubscription | null>(null);
  const pts = useRef<Pt[]>([]);
  const last = useRef<{ lat: number; lon: number } | null>(null);
  const km = useRef(0);
  const max = useRef(0);

  useEffect(() => {
    if (tripId === null) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [tripId, startedAt]);

  useEffect(() => () => { sub.current?.remove(); }, []);

  const start = useCallback(async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) throw new Error("Necesitas permitir la ubicación para registrar el recorrido.");
    const t = await api<{ id: number }>("POST", "/trips");
    pts.current = []; last.current = null; km.current = 0; max.current = 0;
    setStats({ km: 0, kmh: 0, max: 0 }); setElapsed(0);
    setStartedAt(Date.now()); setTripId(t.id); onTripChange(t.id);
    activateKeepAwakeAsync("saferide-trip").catch(() => {});
    sub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
      (loc) => {
        const { latitude: lat, longitude: lon, speed, accuracy } = loc.coords;
        if (accuracy != null && accuracy > 50) return; // lecturas poco fiables
        const kmh = Math.min(300, Math.max(0, (speed ?? 0) * 3.6));
        if (!last.current) last.current = { lat, lon };
        else {
          const d = haversineKm(last.current, { lat, lon });
          if (d * 1000 >= 3) { km.current += d; last.current = { lat, lon }; }
        }
        if (kmh > max.current) max.current = kmh;
        pts.current.push({ lat, lon, speed: Math.round(kmh * 10) / 10, t: loc.timestamp / 1000 });
        if (pts.current.length > 6000) pts.current = pts.current.filter((_, i) => i % 2 === 0);
        setStats({ km: km.current, kmh, max: max.current });
      },
    );
  }, [api, onTripChange]);

  const finish = useCallback(async () => {
    if (tripId === null) return;
    const duration = Math.min(172800, Math.round((Date.now() - startedAt) / 1000));
    await api("POST", `/trips/${tripId}/finish`, {
      distance_km: Math.round(km.current * 100) / 100,
      duration_s: duration,
      max_kmh: Math.round(max.current * 10) / 10,
      route: pts.current,
    });
    sub.current?.remove(); sub.current = null;
    deactivateKeepAwake("saferide-trip").catch(() => {});
    setTripId(null); onTripChange(null);
  }, [api, onTripChange, startedAt, tripId]);

  return { tripId, elapsed, stats, start, finish };
}

export function Home({ active, bleEnabled, onTripChange, onOpenProfile }: {
  active: boolean; bleEnabled: boolean; onTripChange: (id: number | null) => void; onOpenProfile: () => void;
}) {
  const { user, api } = useSession();
  const crash = useCrashAlert();
  const trip = useTrip(api, onTripChange);
  const [contacts, setContacts] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (active) api<Contact[]>("GET", "/contacts").then((c) => setContacts(c.length)).catch(() => {});
  }, [active, api]);

  async function run(fn: () => Promise<void>) {
    setErr(""); setBusy(true);
    try { await fn(); } catch (e) { setErr(message(e)); } finally { setBusy(false); }
  }

  const helmetLine = !bleEnabled ? "Casco sin conectar (activa el Bluetooth en Perfil)" : HELMET_TEXT[crash.helmetState];

  return (
    <Screen title={`Hola, ${user?.name.split(" ")[0] ?? ""}`} subtitle="Pedalea tranquilo: si algo pasa, avisamos.">
      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>{user?.helmet}</Text>
          <Pill text={bleEnabled && crash.helmetState === "connected" ? "Conectado" : "Sin conexión"} tone={bleEnabled && crash.helmetState === "connected" ? "ok" : "neutral"} />
        </View>
        <Text style={{ color: C.sub }}>{helmetLine}{crash.batteryPercent !== null ? ` · batería ${crash.batteryPercent}%` : ""}</Text>
        {bleEnabled && crash.helmetState === "connected" && (
          <Btn kind="secondary" label="Probar alarma del casco" onPress={() => void crash.testHelmetBuzzer()} />
        )}
        {!bleEnabled && <Btn kind="ghost" label="Ir a Perfil" onPress={onOpenProfile} />}
      </Card>

      {contacts === 0 && <Notice text="Aún no tienes contactos. Agrégalos en la pestaña Contactos para que el aviso tenga a quién llegar." />}

      <Card>
        {trip.tripId === null ? (
          <>
            <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>Recorrido</Text>
            <Text style={{ color: C.sub }}>Registra tu ruta con el GPS. Si hay una alerta, se guarda en este recorrido.</Text>
            <Btn label="Iniciar recorrido" loading={busy} onPress={() => run(trip.start)} />
          </>
        ) : (
          <>
            <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>Recorrido en curso</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Stat label="Tiempo" value={fmtDuration(trip.elapsed)} />
              <Stat label="Distancia" value={`${trip.stats.km.toFixed(2)} km`} />
              <Stat label="Velocidad" value={`${trip.stats.kmh.toFixed(0)} km/h`} />
            </View>
            <Btn label="Finalizar recorrido" loading={busy} onPress={() => run(trip.finish)} />
          </>
        )}
      </Card>

      <Card>
        <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>Probar la alerta</Text>
        <Text style={{ color: C.sub }}>Simula un choque para ver la pantalla de alerta, la sirena y el aviso a tus contactos.</Text>
        <Btn kind="danger" label="Simular alerta de posible caída" onPress={() =>
          Alert.alert("Simular alerta", "Sonará la sirena del teléfono y empezará una cuenta regresiva de 30 segundos.", [
            { text: "Cancelar", style: "cancel" }, { text: "Simular", onPress: crash.triggerSimulated },
          ])} />
      </Card>

      {!!err && <Notice tone="danger" text={err} />}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={{ fontSize: 20, fontWeight: "800", color: C.ink }}>{value}</Text>
      <Text style={{ fontSize: 13, color: C.sub }}>{label}</Text>
    </View>
  );
}
