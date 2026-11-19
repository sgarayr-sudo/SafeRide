/**
 * Conexión BLE con el casco. Requiere un *development build* (expo-dev-client):
 * react-native-ble-plx es un módulo nativo y NO funciona en Expo Go.
 * En Expo Go `start()` termina en el estado "unavailable" sin romper la app.
 */
import { PermissionsAndroid, Platform } from "react-native";
import type { BleManager, Device, Subscription } from "react-native-ble-plx";
import {
  BATTERY_CHAR,
  BATTERY_SERVICE,
  CONTROL_CHAR,
  CRASH_CHAR,
  HELMET_SERVICE,
  b64ToBytes,
  bytesToB64,
  crashClientId,
  parseCrashPayload,
  type CrashPayload,
} from "./protocol";

export type HelmetState =
  | "unavailable" // sin módulo nativo (Expo Go) o sin Bluetooth
  | "off" // Bluetooth apagado o sin permisos
  | "scanning"
  | "connecting"
  | "connected"
  | "disconnected";

export interface HelmetEvents {
  onState(state: HelmetState): void;
  onBattery(percent: number): void;
  onCrash(p: CrashPayload, clientId: string): void;
}

export async function ensureBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const api = Number(Platform.Version);
  const wanted =
    api >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
}

export class HelmetBle {
  private manager: BleManager | null = null;
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private seen = new Set<string>();

  constructor(private ev: HelmetEvents) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      // require dinámico: en Expo Go el módulo nativo no existe y un import estático rompería la app.
      const { BleManager: Manager } = require("react-native-ble-plx") as typeof import("react-native-ble-plx");
      this.manager = new Manager();
    } catch {
      this.ev.onState("unavailable");
      return;
    }
    if (!(await ensureBlePermissions())) {
      this.ev.onState("off");
      return;
    }
    this.subs.push(
      this.manager.onStateChange((s) => {
        if (this.stopped) return;
        if (s === "PoweredOn") this.scan();
        else this.ev.onState(s === "Unsupported" ? "unavailable" : "off");
      }, true),
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    this.manager?.stopDeviceScan();
    this.device?.cancelConnection().catch(() => {});
    this.manager?.destroy();
    this.manager = null;
    this.device = null;
  }

  /** Escribe un comando en la característica CONTROL. Devuelve false si no hay casco conectado. */
  async send(cmd: readonly number[]): Promise<boolean> {
    if (!this.device) return false;
    try {
      await this.device.writeCharacteristicWithResponseForService(HELMET_SERVICE, CONTROL_CHAR, bytesToB64(cmd));
      return true;
    } catch {
      return false;
    }
  }

  private scan() {
    if (!this.manager || this.stopped) return;
    this.ev.onState("scanning");
    this.manager.startDeviceScan([HELMET_SERVICE], { allowDuplicates: false }, (err, dev) => {
      if (err) return this.scheduleRetry();
      if (!dev) return;
      this.manager?.stopDeviceScan();
      this.connect(dev);
    });
  }

  private async connect(dev: Device) {
    if (this.stopped) return;
    this.ev.onState("connecting");
    try {
      const d = await dev.connect({ timeout: 10000 });
      await d.discoverAllServicesAndCharacteristics();
      this.device = d;
      this.attempts = 0;
      this.subs.push(
        d.onDisconnected(() => {
          this.device = null;
          if (this.stopped) return;
          this.ev.onState("disconnected");
          this.scheduleRetry();
        }),
      );
      this.ev.onState("connected");
      this.watchBattery(d);
      // Un choque ocurrido mientras el teléfono estaba desconectado sigue activo en el casco: se lee al conectar.
      const first = await d.readCharacteristicForService(HELMET_SERVICE, CRASH_CHAR).catch(() => null);
      this.handleCrash(d.id, first?.value);
      this.subs.push(
        d.monitorCharacteristicForService(HELMET_SERVICE, CRASH_CHAR, (err, ch) => {
          if (!err) this.handleCrash(d.id, ch?.value);
        }),
      );
    } catch {
      this.device = null;
      this.scheduleRetry();
    }
  }

  private handleCrash(deviceId: string, b64: string | null | undefined) {
    const p = parseCrashPayload(b64);
    if (!p || p.type === "idle") return;
    const id = crashClientId(deviceId, p);
    // El casco repite la notificación cada ~2 s: se entrega una vez por tipo y choque.
    const key = `${id}:${p.type}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 50) this.seen.delete(this.seen.values().next().value as string);
    this.ev.onCrash(p, id);
  }

  private async watchBattery(d: Device) {
    try {
      const c = await d.readCharacteristicForService(BATTERY_SERVICE, BATTERY_CHAR);
      if (c.value) this.ev.onBattery(batteryPercent(c.value));
      this.subs.push(
        d.monitorCharacteristicForService(BATTERY_SERVICE, BATTERY_CHAR, (err, ch) => {
          if (!err && ch?.value) this.ev.onBattery(batteryPercent(ch.value));
        }),
      );
    } catch {
      /* el casco puede no exponer batería */
    }
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.manager?.stopDeviceScan();
    const wait = Math.min(10000, 1000 * 2 ** Math.min(this.attempts++, 4));
    this.retry = setTimeout(() => this.scan(), wait);
  }
}

function batteryPercent(b64: string): number {
  return Math.min(100, Math.max(0, b64ToBytes(b64)[0] ?? 0));
}
