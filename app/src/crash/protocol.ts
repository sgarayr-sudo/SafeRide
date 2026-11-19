/** Contrato BLE casco ↔ app. Ver docs/BLE_PROTOCOLO.md. */

export const HELMET_SERVICE = "7d5a1000-3c1e-4b7a-9d2f-5a1e51de0001";
export const CRASH_CHAR = "7d5a1001-3c1e-4b7a-9d2f-5a1e51de0001";
export const CONTROL_CHAR = "7d5a1002-3c1e-4b7a-9d2f-5a1e51de0001";
export const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
export const BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb";

export type CrashType = "idle" | "impact" | "fall" | "cancel";

export interface CrashPayload {
  type: CrashType;
  /** Fuerza pico en g. */
  peakG: number;
  bootId: number;
  seq: number;
}

/** Comandos que la app escribe en la característica CONTROL del casco. */
export const HelmetCmd = {
  silence: [0x01],
  sound: [0x02],
  test: [0x03],
  sensitivity: (level: 0 | 1 | 2) => [0x10, level],
} as const;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64ToBytes(b64: string): number[] {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

export function bytesToB64(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += b === undefined ? "=" : B64[(n >> 6) & 63];
    out += c === undefined ? "=" : B64[n & 63];
  }
  return out;
}

const TYPES: CrashType[] = ["idle", "impact", "fall", "cancel"];

/** Decodifica los 8 bytes de la característica CRASH. Devuelve null si el paquete no es válido. */
export function parseCrashPayload(b64: string | null | undefined): CrashPayload | null {
  if (!b64) return null;
  const b = b64ToBytes(b64);
  if (b.length < 8 || b[0] !== 1) return null;
  const type = TYPES[b[1]];
  if (!type) return null;
  return {
    type,
    peakG: (b[2] | (b[3] << 8)) / 10,
    bootId: b[4] | (b[5] << 8),
    seq: b[6] | (b[7] << 8),
  };
}

/** Identificador estable del choque, igual en todas las repeticiones BLE y reconexiones. */
export function crashClientId(deviceId: string, p: Pick<CrashPayload, "bootId" | "seq">): string {
  return `${deviceId}:${p.bootId}:${p.seq}`;
}
