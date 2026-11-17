/**
 * Alerta de choque en la app.
 *
 * - Escucha al casco por BLE (HelmetBle) y, al recibir un choque, muestra una pantalla de alerta
 *   a pantalla completa con sirena, vibración y cuenta regresiva.
 * - Registra el evento en el servidor (idempotente por client_id) y lo resuelve según lo que haga
 *   el ciclista: «Estoy bien», «Pedir ayuda ahora» o cuenta regresiva agotada.
 * - Si la app se cierra o el teléfono muere, el servidor escala la alerta por su cuenta (expires_at).
 * - Al abrir la app o volver a primer plano recupera una alerta que siga activa.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Vibration } from "react-native";
import { ApiError, type ApiEvent, type CrashApi, type ResolveBody } from "./api";
import { CrashAlertOverlay } from "./CrashAlertOverlay";
import { HelmetBle, type HelmetState } from "./HelmetBle";
import { HelmetCmd, type CrashPayload } from "./protocol";

const COUNTDOWN_S = 30;
/** Tiempo máximo que la app sigue reintentando contarle al servidor lo ocurrido. */
const SYNC_WINDOW_MS = 10 * 60 * 1000;

export interface ActiveAlert {
  /** Id en el servidor; null mientras se registra (p. ej. sin conexión). */
  eventId: number | null;
  clientId: string;
  source: "helmet" | "phone";
  peakG: number | null;
  /** Instante (ms, reloj local) en que vence la cuenta regresiva. */
  deadline: number;
  /** "pending" mientras corre la cuenta; "sending" mientras se confirma al servidor. */
  phase: "pending" | "sending";
}

export interface CrashAlertSettings {
  /** Ajuste «phone_sound»: sirena en el teléfono. */
  phoneSound: boolean;
}

interface Props {
  api: CrashApi;
  settings?: CrashAlertSettings;
  /** Ubicación actual, si está disponible (se adjunta al evento). */
  getLocation?: () => Promise<{ lat: number; lon: number } | null>;
  /** Recorrido en curso, si lo hay. */
  tripId?: number | null;
  /** Desactiva la conexión BLE (p. ej. ajuste de Bluetooth apagado). */
  bluetoothEnabled?: boolean;
  children: React.ReactNode;
}

interface Ctx {
  helmetState: HelmetState;
  batteryPercent: number | null;
  alert: ActiveAlert | null;
  /** Dispara una alerta como si viniera del casco; sirve para el botón «Simular alerta» y para pruebas. */
  triggerSimulated(): void;
  /** Silencia/enciende el buzzer del casco con un pitido de prueba. */
  testHelmetBuzzer(): Promise<boolean>;
}

const CrashContext = createContext<Ctx | null>(null);

export function useCrashAlert(): Ctx {
  const c = useContext(CrashContext);
  if (!c) throw new Error("useCrashAlert debe usarse dentro de <CrashAlertProvider>");
  return c;
}

export function CrashAlertProvider({
  api,
  settings = { phoneSound: true },
  getLocation,
  tripId = null,
  bluetoothEnabled = true,
  children,
}: Props) {
  const [helmetState, setHelmetState] = useState<HelmetState>("unavailable");
  const [battery, setBattery] = useState<number | null>(null);
  const [alert, setAlert] = useState<ActiveAlert | null>(null);
  const [now, setNow] = useState(Date.now());

  // Referencias para que los callbacks de BLE (creados una vez) vean siempre lo último.
  const alertRef = useRef<ActiveAlert | null>(null);
  const apiRef = useRef(api);
  const settingsRef = useRef(settings);
  const locRef = useRef(getLocation);
  const tripRef = useRef(tripId);
  apiRef.current = api;
  settingsRef.current = settings;
  locRef.current = getLocation;
  tripRef.current = tripId;
  const helmet = useRef<HelmetBle | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const finished = useRef(new Set<string>()); // choques ya cerrados: evitan reabrir la alerta
  const eventIds = useRef(new Map<string, Promise<number | null>>()); // registro en el servidor en curso

  const setActive = useCallback((a: ActiveAlert | null) => {
    alertRef.current = a;
    setAlert(a);
  }, []);

  // ── Sirena, vibración y pantalla encendida ──
  const startAlarm = useCallback(async () => {
    activateKeepAwakeAsync("saferide-crash").catch(() => {});
    Vibration.vibrate([0, 700, 400], true);
    if (!settingsRef.current.phoneSound) return;
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "doNotMix" });
      if (!player.current) {
        player.current = createAudioPlayer(require("../../assets/alarm.wav"));
        player.current.loop = true;
        player.current.volume = 1;
      }
      player.current.seekTo(0).catch(() => {});
      player.current.play();
    } catch {
      /* sin sonido seguimos con vibración y pantalla */
    }
  }, []);

  const stopAlarm = useCallback(() => {
    Vibration.cancel();
    deactivateKeepAwake("saferide-crash").catch(() => {});
    try {
      player.current?.pause();
    } catch {
      /* noop */
    }
  }, []);

  // ── Reintentos: la red puede fallar justo después de un choque ──
  const withRetry = useCallback(async <T,>(fn: () => Promise<T>, stillWanted: () => boolean): Promise<T | null> => {
    for (let i = 0; stillWanted(); i++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.permanent) return null;
        await new Promise<void>((r) => setTimeout(r, Math.min(5000, 1000 * (i + 1))));
      }
    }
    return null;
  }, []);

  const close = useCallback(
    (clientId: string) => {
      finished.current.add(clientId);
      stopAlarm();
      setActive(null);
    },
    [setActive, stopAlarm],
  );

  const resolve = useCallback(
    async (body: ResolveBody) => {
      const a = alertRef.current;
      if (!a || a.phase === "sending") return;
      setActive({ ...a, phase: "sending" }); // evita toques repetidos mientras se cierra
      // Lo local primero y sin esperar: casco, sirena y pantalla responden al instante, haya red o no.
      void helmet.current?.send(body.status === "descartada" ? HelmetCmd.silence : HelmetCmd.sound);
      close(a.clientId);
      // Después se informa al servidor, con reintentos si no hay red.
      const until = Date.now() + SYNC_WINDOW_MS;
      const eventId = a.eventId ?? (await eventIds.current.get(a.clientId)) ?? null;
      if (eventId) await withRetry(() => apiRef.current.resolveEvent(eventId, body), () => Date.now() < until);
      eventIds.current.delete(a.clientId);
    },
    [close, setActive, withRetry],
  );

  const imOk = useCallback(() => resolve({ status: "descartada", reason: "user_ok" }), [resolve]);
  const askForHelp = useCallback(() => resolve({ status: "notificada", reason: "user_confirmed" }), [resolve]);

  // ── Inicio de una alerta ──
  const beginAlert = useCallback(
    async (p: { clientId: string; source: "helmet" | "phone"; type: "impact" | "fall"; peakG: number | null }) => {
      if (alertRef.current || finished.current.has(p.clientId)) return; // ya hay una alerta o ya se cerró esta
      const a: ActiveAlert = {
        eventId: null,
        clientId: p.clientId,
        source: p.source,
        peakG: p.peakG,
        deadline: Date.now() + COUNTDOWN_S * 1000,
        phase: "pending",
      };
      setActive(a);
      startAlarm(); // sin esperar a la red
      const register = (async () => {
        const loc = await Promise.race([
          locRef.current?.().catch(() => null) ?? Promise.resolve(null),
          new Promise<null>((r) => setTimeout(() => r(null), 1500)),
        ]);
        const until = Date.now() + SYNC_WINDOW_MS;
        const ev = await withRetry(
          () =>
            apiRef.current.createEvent({
              kind: p.type,
              severity: "alta",
              source: p.source,
              client_id: p.clientId,
              peak_g: p.peakG ?? undefined,
              countdown_s: COUNTDOWN_S,
              lat: loc?.lat,
              lon: loc?.lon,
              trip_id: tripRef.current ?? undefined,
            }),
          () => Date.now() < until,
        );
        const cur = alertRef.current;
        if (ev && cur?.clientId === p.clientId) setActive({ ...cur, eventId: ev.id });
        return ev?.id ?? null;
      })();
      eventIds.current.set(p.clientId, register);
      await register;
    },
    [setActive, startAlarm, withRetry],
  );

  // ── Casco por BLE ──
  const onCrash = useCallback(
    (p: CrashPayload, clientId: string) => {
      if (p.type === "cancel") {
        const a = alertRef.current;
        if (a && a.clientId === clientId) void resolve({ status: "descartada", reason: "user_ok" });
        return;
      }
      if (p.type === "impact" || p.type === "fall") {
        void beginAlert({ clientId, source: "helmet", type: p.type, peakG: p.peakG });
      }
    },
    [beginAlert, resolve],
  );

  const onCrashRef = useRef(onCrash);
  onCrashRef.current = onCrash;

  useEffect(() => {
    if (!bluetoothEnabled) return;
    const h = new HelmetBle({
      onState: setHelmetState,
      onBattery: setBattery,
      onCrash: (p, id) => onCrashRef.current(p, id),
    });
    helmet.current = h;
    void h.start();
    return () => {
      h.stop();
      helmet.current = null;
    };
  }, [bluetoothEnabled]);

  // ── Recuperar una alerta activa al abrir la app / volver a primer plano ──
  const recover = useCallback(async () => {
    if (alertRef.current) return;
    try {
      const { now: serverNow, events } = await apiRef.current.getActive();
      const ev: ApiEvent | undefined = events.find((e) => e.expires_at && !finished.current.has(e.client_id ?? `srv:${e.id}`));
      if (!ev || !ev.expires_at || alertRef.current) return;
      setActive({
        eventId: ev.id,
        clientId: ev.client_id ?? `srv:${ev.id}`,
        source: ev.source === "helmet" ? "helmet" : "phone",
        peakG: ev.peak_g,
        deadline: Date.now() + (ev.expires_at - serverNow) * 1000,
        phase: "pending",
      });
      void startAlarm();
    } catch {
      /* sin red o sin sesión: nada que recuperar */
    }
  }, [setActive, startAlarm]);

  useEffect(() => {
    void recover();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void recover());
    return () => sub.remove();
  }, [recover]);

  // ── Cuenta regresiva ──
  useEffect(() => {
    if (!alert || alert.phase !== "pending") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [alert]);

  useEffect(() => {
    if (alert && alert.phase === "pending" && now >= alert.deadline) {
      void resolve({ status: "notificada", reason: "timeout" });
    }
  }, [alert, now, resolve]);

  useEffect(() => () => {
    stopAlarm();
    try {
      player.current?.remove();
    } catch {
      /* noop */
    }
  }, [stopAlarm]);

  const value = useMemo<Ctx>(
    () => ({
      helmetState,
      batteryPercent: battery,
      alert,
      triggerSimulated: () =>
        void beginAlert({ clientId: `sim:${Date.now()}`, source: "phone", type: "impact", peakG: null }),
      testHelmetBuzzer: async () => (await helmet.current?.send(HelmetCmd.test)) ?? false,
    }),
    [alert, battery, beginAlert, helmetState],
  );

  const remainingS = alert ? Math.max(0, Math.ceil((alert.deadline - now) / 1000)) : 0;

  return (
    <CrashContext.Provider value={value}>
      {children}
      <CrashAlertOverlay
        alert={alert}
        remainingS={remainingS}
        totalS={COUNTDOWN_S}
        onImOk={imOk}
        onAskForHelp={askForHelp}
      />
    </CrashContext.Provider>
  );
}
