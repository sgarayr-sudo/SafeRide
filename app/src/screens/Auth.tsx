import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { message } from "../api";
import { useSession } from "../session";
import { C } from "../theme";
import { Btn, Field, Notice } from "../ui";

export function AuthScreen() {
  const session = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(session.url);
  const [showServer, setShowServer] = useState(!session.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (!email.trim() || !password) return setError("Escribe tu correo y contraseña.");
    if (mode === "register" && name.trim().length < 2) return setError("Escribe tu nombre.");
    if (mode === "register" && password.length < 6) return setError("La contraseña debe tener al menos 6 caracteres.");
    setBusy(true);
    try {
      if (mode === "login") await session.login(server, email.trim(), password);
      else await session.register(server, name.trim(), email.trim(), password);
    } catch (e) {
      setError(message(e));
      setShowServer(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 4 }}>
            <Text style={s.brand}>SafeRide</Text>
            <Text style={s.tag}>Tu casco avisa. Tu app responde.</Text>
          </View>

          <View style={s.form}>
            {mode === "register" && <Field label="Nombre" value={name} onChangeText={setName} autoCapitalize="words" />}
            <Field label="Correo" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} />
            <Field label="Contraseña" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
            {showServer && (
              <Field label="Dirección del servidor" value={server} onChangeText={setServer} autoCapitalize="none"
                autoCorrect={false} keyboardType="url" placeholder="https://tu-servicio.onrender.com" />
            )}
            {!!error && <Notice tone="danger" text={error} />}
            {busy && <Notice tone="neutral" text="Conectando… la primera vez el servidor puede tardar hasta un minuto en despertar." />}
            <Btn label={mode === "login" ? "Entrar" : "Crear cuenta"} onPress={submit} loading={busy} />
            <Btn kind="ghost" label={mode === "login" ? "No tengo cuenta" : "Ya tengo cuenta"} onPress={() => { setError(""); setMode(mode === "login" ? "register" : "login"); }} />
            <Btn kind="ghost" label="Usar cuenta de prueba" onPress={() => { setMode("login"); setEmail("demo@saferide.app"); setPassword("demo1234"); }} />
            {!showServer && <Btn kind="ghost" label="Cambiar servidor" onPress={() => setShowServer(true)} />}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  content: { flexGrow: 1, padding: 24, justifyContent: "center", gap: 28 },
  brand: { fontSize: 40, fontWeight: "800", color: C.ink },
  tag: { fontSize: 16, color: C.sub },
  form: { gap: 14 },
});
