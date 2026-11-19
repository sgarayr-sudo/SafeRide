import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./crash/api";
import { KEYS, configuredUrl, makeClient, normalizeUrl, store, type Request, type Settings, type User } from "./api";

interface Session {
  ready: boolean;
  url: string;
  token: string | null;
  user: User | null;
  api: Request;
  login(url: string, email: string, password: string): Promise<void>;
  register(url: string, name: string, email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
}

const Ctx = createContext<Session | null>(null);
export const useSession = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession fuera de SessionProvider");
  return c;
};

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [url, setUrl] = useState(configuredUrl());
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const tokenRef = useRef<string | null>(null);

  const clear = useCallback(async () => {
    tokenRef.current = null;
    setToken(null);
    setUser(null);
    await Promise.all([store.del(KEYS.token), store.del(KEYS.user)]);
  }, []);

  const api = useMemo(() => makeClient(url, () => tokenRef.current, 25000, () => void clear()), [url, clear]);

  const persist = useCallback(async (u: string, t: string, usr: User) => {
    tokenRef.current = t;
    setUrl(u); setToken(t); setUser(usr);
    await Promise.all([store.set(KEYS.url, u), store.set(KEYS.token, t), store.set(KEYS.user, JSON.stringify(usr))]);
  }, []);

  // Al abrir: recupera la sesión guardada y la valida contra el servidor.
  useEffect(() => {
    (async () => {
      const [savedUrl, savedToken, savedUser] = await Promise.all([store.get(KEYS.url), store.get(KEYS.token), store.get(KEYS.user)]);
      const base = savedUrl || configuredUrl();
      setUrl(base);
      if (savedToken && base) {
        tokenRef.current = savedToken;
        setToken(savedToken);
        try { setUser(JSON.parse(savedUser ?? "null")); } catch { /* sin caché */ }
        try {
          const fresh = await makeClient(base, () => savedToken, 60000)<User>("GET", "/me");
          setUser(fresh);
          await store.set(KEYS.user, JSON.stringify(fresh));
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) await clear(); // sesión vencida o servidor reiniciado
        }
      }
      setReady(true);
    })();
  }, [clear]);

  const auth = useCallback(
    async (rawUrl: string, path: string, body: unknown) => {
      const base = normalizeUrl(rawUrl);
      if (!base) throw new Error("Escribe la dirección del servidor.");
      const r = await makeClient(base, () => null, 60000)<{ token: string; user: User }>("POST", path, body);
      await persist(base, r.token, r.user);
    },
    [persist],
  );

  const value = useMemo<Session>(
    () => ({
      ready, url, token, user, api,
      login: (u, email, password) => auth(u, "/auth/login", { email, password }),
      register: (u, name, email, password) => auth(u, "/auth/register", { name, email, password }),
      logout: clear,
      saveSettings: async (patch) => {
        const next = await api<User>("PUT", "/me", { settings: patch });
        setUser(next);
        await store.set(KEYS.user, JSON.stringify(next));
      },
    }),
    [ready, url, token, user, api, auth, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
