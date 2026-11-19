import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { ApiError } from "./crash/api";

export interface Settings {
  location: boolean; notifications: boolean; bluetooth: boolean; sensitivity: 0 | 1 | 2;
  helmet_demo: boolean; buzzer: boolean; phone_sound: boolean; share_location: boolean; save_history: boolean;
}
export interface User { id: number; email: string; name: string; helmet: string; settings: Settings }
export interface Contact { id: number; name: string; relation: string; phone: string; priority: number }
export interface Trip { id: number; started: number; ended: number | null; distance_km: number; duration_s: number; avg_kmh: number; max_kmh: number; events: number }
export interface TimelineStep { label: string; detail: string; done: boolean; ts: number }
export interface EventItem {
  id: number; kind: string; severity: string; status: string; source: string; ts: number;
  place: string; note: string; peak_g: number | null; timeline: TimelineStep[];
}

export type Request = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export const KEYS = { url: "saferide.url", token: "saferide.token", user: "saferide.user", ble: "saferide.ble" };
export const store = {
  get: (k: string) => AsyncStorage.getItem(k).catch(() => null),
  set: (k: string, v: string) => AsyncStorage.setItem(k, v).catch(() => {}),
  del: (k: string) => AsyncStorage.removeItem(k).catch(() => {}),
};

/** URL del servidor definida al construir la app (app.json → extra.apiUrl). */
export function configuredUrl(): string {
  const u = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "";
  return u.includes("PON_AQUI") ? "" : u;
}

export function normalizeUrl(raw: string): string {
  const u = raw.trim().replace(/\/+$/, "");
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Texto entendible para mostrar al usuario. */
export function message(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const d = JSON.parse(e.detail).detail;
      if (typeof d === "string") return d;
      if (Array.isArray(d)) return "Revisa los datos ingresados.";
    } catch { /* texto no JSON */ }
    return `Error del servidor (${e.status}).`;
  }
  if (e instanceof Error && e.name === "AbortError")
    return "El servidor tardó demasiado. Si es la primera vez puede estar despertando: espera un minuto e inténtalo otra vez.";
  if (e instanceof Error && e.message && !/network|fetch|failed/i.test(e.message)) return e.message;
  return "No se pudo conectar con el servidor. Revisa tu internet y la dirección del servidor.";
}

export function makeClient(
  baseUrl: string, getToken: () => string | null, timeoutMs = 25000, onUnauthorized?: () => void,
): Request {
  return async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const token = getToken();
      const res = await fetch(baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 && token) onUnauthorized?.();
        throw new ApiError(res.status, await res.text().catch(() => ""));
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };
}
