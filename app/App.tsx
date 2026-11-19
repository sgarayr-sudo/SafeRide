import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { KEYS, store } from "./src/api";
import { CrashAlertProvider, makeCrashApi } from "./src/crash";
import { AuthScreen } from "./src/screens/Auth";
import { Contacts } from "./src/screens/Contacts";
import { History } from "./src/screens/History";
import { Home } from "./src/screens/Home";
import { Profile } from "./src/screens/Profile";
import { SessionProvider, useSession } from "./src/session";
import { C } from "./src/theme";

type Tab = "home" | "contacts" | "history" | "profile";
const TABS: { key: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "home", label: "Inicio", icon: "home" },
  { key: "contacts", label: "Contactos", icon: "people" },
  { key: "history", label: "Historial", icon: "time" },
  { key: "profile", label: "Perfil", icon: "person" },
];

function Authed() {
  const { url, token, user } = useSession();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("home");
  const [tripId, setTripId] = useState<number | null>(null);
  const [ble, setBle] = useState(false);

  useEffect(() => { void store.get(KEYS.ble).then((v) => setBle(v === "1")); }, []);
  const changeBle = useCallback((v: boolean) => { setBle(v); void store.set(KEYS.ble, v ? "1" : "0"); }, []);

  const crashApi = useMemo(() => makeCrashApi(url, () => token), [url, token]);
  const getLocation = useCallback(async () => {
    try {
      if (!(await Location.getForegroundPermissionsAsync()).granted) return null;
      const p = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      return { lat: p.coords.latitude, lon: p.coords.longitude };
    } catch { return null; }
  }, []);

  // Las pestañas se mantienen montadas (ocultas) para no perder un recorrido en curso al cambiar de pantalla.
  const show = (k: Tab) => ({ flex: 1, display: tab === k ? ("flex" as const) : ("none" as const) });

  return (
    <CrashAlertProvider api={crashApi} settings={{ phoneSound: user?.settings.phone_sound ?? true }}
      bluetoothEnabled={ble} tripId={tripId} getLocation={getLocation}>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={show("home")}><Home active={tab === "home"} bleEnabled={ble} onTripChange={setTripId} onOpenProfile={() => setTab("profile")} /></View>
        <View style={show("contacts")}><Contacts active={tab === "contacts"} /></View>
        <View style={show("history")}><History active={tab === "history"} /></View>
        <View style={show("profile")}><Profile bleEnabled={ble} onBleChange={changeBle} /></View>
        <View style={{ flexDirection: "row", backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: C.line, paddingBottom: insets.bottom }}>
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <Pressable key={t.key} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: on }}
                style={{ flex: 1, alignItems: "center", paddingVertical: 10, gap: 2 }}>
                <Ionicons name={t.icon} size={24} color={on ? C.brand : C.sub} />
                <Text style={{ fontSize: 12, fontWeight: "600", color: on ? C.brand : C.sub }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </CrashAlertProvider>
  );
}

function Root() {
  const { ready, token } = useSession();
  if (!ready) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.bg }}><ActivityIndicator color={C.brand} size="large" /></View>;
  return token ? <Authed /> : <AuthScreen />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SessionProvider><Root /></SessionProvider>
    </SafeAreaProvider>
  );
}
