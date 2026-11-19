/** Cliente mínimo para los endpoints de alertas de SafeRide. Independiente del resto de la app. */

export interface ApiEvent {
  id: number;
  kind: "impact" | "fall" | "sent" | "system";
  status: "preliminar" | "notificada" | "descartada";
  source: "helmet" | "phone" | "manual" | "system";
  client_id: string | null;
  peak_g: number | null;
  expires_at: number | null;
  lat: number | null;
  lon: number | null;
  ts: number;
}

export interface CreateEventBody {
  kind: "impact" | "fall";
  severity: "alta" | "media" | "baja";
  source: "helmet" | "phone" | "manual";
  client_id?: string;
  peak_g?: number;
  countdown_s?: number;
  lat?: number;
  lon?: number;
  trip_id?: number;
  place?: string;
}

export interface ResolveBody {
  status: "descartada" | "notificada";
  reason?: "user_ok" | "user_confirmed" | "timeout";
}

export interface CrashApi {
  createEvent(body: CreateEventBody): Promise<ApiEvent>;
  resolveEvent(id: number, body: ResolveBody): Promise<ApiEvent>;
  getActive(): Promise<{ now: number; events: ApiEvent[] }>;
}

export function makeCrashApi(
  baseUrl: string,
  getToken: () => string | null | Promise<string | null>,
  timeoutMs = 8000,
): CrashApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const token = await getToken();
      const res = await fetch(baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ApiError(res.status, detail);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    createEvent: (b) => call("POST", "/events", b),
    resolveEvent: (id, b) => call("POST", `/events/${id}/resolve`, b),
    getActive: () => call("GET", "/events/active"),
  };
}

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(`HTTP ${status}: ${detail}`);
  }
  /** Un 4xx (salvo 408/429) no mejora al reintentar. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}
