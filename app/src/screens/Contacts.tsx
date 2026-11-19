import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { message, type Contact } from "../api";
import { useSession } from "../session";
import { C } from "../theme";
import { Btn, Card, Chip, Empty, Field, Notice, Pill, Screen } from "../ui";

const RELATIONS = ["Familia", "Pareja", "Amigo/a", "Otro"];

export function Contacts({ active }: { active: boolean }) {
  const { api } = useSession();
  const [list, setList] = useState<Contact[] | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [relation, setRelation] = useState(RELATIONS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try { setList(await api<Contact[]>("GET", "/contacts")); } catch (e) { setErr(message(e)); }
  }, [api]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  async function add() {
    setErr("");
    if (name.trim().length < 2) return setErr("Escribe el nombre del contacto.");
    if (phone.replace(/\D/g, "").length < 7) return setErr("Escribe un teléfono válido.");
    setBusy(true);
    try {
      setList(await api<Contact[]>("POST", "/contacts", { name: name.trim(), relation, phone: phone.trim() }));
      setName(""); setPhone("");
    } catch (e) { setErr(message(e)); } finally { setBusy(false); }
  }

  const remove = (c: Contact) =>
    Alert.alert("Eliminar contacto", `¿Eliminar a ${c.name}?`, [
      { text: "Cancelar", style: "cancel" },
      { text: "Eliminar", style: "destructive", onPress: async () => {
        try { setList(await api<Contact[]>("DELETE", `/contacts/${c.id}`)); } catch (e) { setErr(message(e)); }
      } },
    ]);

  const makePrimary = async (c: Contact) => {
    try { setList(await api<Contact[]>("POST", `/contacts/${c.id}/primary`)); } catch (e) { setErr(message(e)); }
  };

  return (
    <Screen title="Contactos" subtitle="Ellos recibirán el aviso si no respondes a una alerta." onRefresh={load}>
      {!!err && <Notice tone="danger" text={err} />}
      {list && list.length === 0 && <Empty text="Todavía no tienes contactos de emergencia." />}
      {list?.map((c, i) => (
        <Card key={c.id}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink, flex: 1 }}>{c.name}</Text>
            {i === 0 && <Pill text="Principal" tone="ok" />}
          </View>
          <Text style={{ color: C.sub }}>{c.relation} · {c.phone}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {i !== 0 && <View style={{ flex: 1 }}><Btn kind="secondary" label="Hacer principal" onPress={() => makePrimary(c)} /></View>}
            <View style={{ flex: 1 }}><Btn kind="danger" label="Eliminar" onPress={() => remove(c)} /></View>
          </View>
        </Card>
      ))}
      <Card>
        <Text style={{ fontSize: 17, fontWeight: "700", color: C.ink }}>Agregar contacto</Text>
        <Field label="Nombre" value={name} onChangeText={setName} autoCapitalize="words" />
        <Field label="Teléfono" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+57 300 000 0000" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {RELATIONS.map((r) => <Chip key={r} label={r} selected={relation === r} onPress={() => setRelation(r)} />)}
        </View>
        <Btn label="Agregar" onPress={add} loading={busy} />
      </Card>
    </Screen>
  );
}
