import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { message, type EventItem, type Trip } from "../api";
import { useSession } from "../session";
import { C } from "../theme";
import { Btn, Card, Chip, Empty, Notice, Pill, Screen, fmtDate, fmtDuration } from "../ui";

const STATUS: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  preliminar: { text: "Sin confirmar", tone: "warn" },
  descartada: { text: "Descartada · estaba bien", tone: "ok" },
  notificada: { text: "Aviso registrado", tone: "danger" },
};
const SOURCE: Record<string, string> = { helmet: "Casco", phone: "Teléfono", manual: "Manual", system: "Sistema" };

export function History({ active }: { active: boolean }) {
  const { api } = useSession();
  const [tab, setTab] = useState<"trips" | "events">("trips");
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true); setErr("");
    try {
      const [t, e] = await Promise.all([api<Trip[]>("GET", "/trips"), api<EventItem[]>("GET", "/events?limit=100")]);
      setTrips(t); setEvents(e);
    } catch (x) { setErr(message(x)); } finally { setRefreshing(false); }
  }, [api]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const removeTrip = (t: Trip) =>
    Alert.alert("Eliminar recorrido", "Se borrará también sus alertas.", [
      { text: "Cancelar", style: "cancel" },
      { text: "Eliminar", style: "destructive", onPress: async () => {
        try { await api("DELETE", `/trips/${t.id}`); void load(); } catch (x) { setErr(message(x)); }
      } },
    ]);

  return (
    <Screen title="Historial" onRefresh={load} refreshing={refreshing}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip label="Recorridos" selected={tab === "trips"} onPress={() => setTab("trips")} />
        <Chip label="Alertas" selected={tab === "events"} onPress={() => setTab("events")} />
      </View>
      {!!err && <Notice tone="danger" text={err} />}

      {tab === "trips" && (trips?.length === 0 ? <Empty text="Aún no hay recorridos. Inicia uno desde Inicio." /> :
        trips?.map((t) => (
          <Card key={t.id}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: C.ink }}>{fmtDate(t.started)}</Text>
              {t.events > 0 && <Pill text={`${t.events} alerta${t.events > 1 ? "s" : ""}`} tone="warn" />}
            </View>
            <Text style={{ color: C.sub }}>
              {t.distance_km.toFixed(1)} km · {fmtDuration(t.duration_s)} · prom. {t.avg_kmh.toFixed(0)} km/h · máx. {t.max_kmh.toFixed(0)} km/h
            </Text>
            <Btn kind="ghost" label="Eliminar" onPress={() => removeTrip(t)} />
          </Card>
        )))}

      {tab === "events" && (events?.length === 0 ? <Empty text="No hay alertas registradas." /> :
        events?.map((e) => {
          const st = e.kind === "sent" ? { text: "Aviso a contactos registrado", tone: "danger" as const } : STATUS[e.status] ?? STATUS.preliminar;
          const title = e.kind === "sent" ? "Aviso a contactos" : "Posible choque";
          return (
            <Pressable key={e.id} onPress={() => setOpen(open === e.id ? null : e.id)} accessibilityRole="button" accessibilityLabel={`${title}, ${st.text}`}>
              <Card>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontSize: 16, fontWeight: "700", color: C.ink }}>{title}</Text>
                  <Text style={{ color: C.sub, fontSize: 13 }}>{fmtDate(e.ts)}</Text>
                </View>
                <Pill text={st.text} tone={st.tone} />
                <Text style={{ color: C.sub }}>
                  {SOURCE[e.source] ?? e.source}{e.peak_g ? ` · ${e.peak_g.toFixed(1)} g` : ""}{e.note ? ` · ${e.note}` : ""}
                </Text>
                {open === e.id && e.timeline.map((s, i) => (
                  <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: C.line, paddingLeft: 10 }}>
                    <Text style={{ fontWeight: "600", color: C.ink }}>{s.label}</Text>
                    <Text style={{ color: C.sub, fontSize: 13 }}>{s.detail}</Text>
                  </View>
                ))}
                {open === e.id && e.timeline.length === 0 && <Text style={{ color: C.sub, fontSize: 13 }}>Sin más detalles.</Text>}
              </Card>
            </Pressable>
          );
        }))}
    </Screen>
  );
}
