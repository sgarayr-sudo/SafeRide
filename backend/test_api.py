"""Pruebas del backend. Ejecutar:  pytest -q"""
import time

import jwt


def reg(api, email="a@x.co", name="Test User"):
    r = api.post("/auth/register", json={"name": name, "email": email, "password": "secret1"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def crash(api, h, **kw):
    body = {"kind": "impact", "severity": "alta", "source": "helmet", **kw}
    r = api.post("/events", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


# ── Seguridad ──
def test_no_hay_secreto_por_defecto_conocido(api):
    forged = jwt.encode({"sub": "1", "exp": int(time.time()) + 999}, "cambia-este-secreto-en-produccion", algorithm="HS256")
    assert api.get("/me", headers={"Authorization": "Bearer " + forged}).status_code == 401


def test_login_demo_y_credenciales_malas(api):
    assert api.post("/auth/login", json={"email": "demo@saferide.app", "password": "demo1234"}).status_code == 200
    assert api.post("/auth/login", json={"email": "demo@saferide.app", "password": "mala"}).status_code == 401
    assert api.post("/auth/login", json={"email": "nadie@x.co", "password": "mala"}).status_code == 401


def test_limite_de_intentos_de_login(api):
    for _ in range(8):
        api.post("/auth/login", json={"email": "z@x.co", "password": "mala"})
    assert api.post("/auth/login", json={"email": "z@x.co", "password": "mala"}).status_code == 429


def test_ajustes_se_validan(api):
    h = reg(api)
    r = api.put("/me", json={"settings": {"sensitivity": 9, "buzzer": "si", "phone_sound": False, "hack": 1}}, headers=h).json()
    assert r["settings"]["sensitivity"] == 1 and r["settings"]["buzzer"] is True
    assert r["settings"]["phone_sound"] is False and "hack" not in r["settings"]


# ── Contactos ──
def test_editar_contacto_no_cambia_su_posicion(api):
    h = reg(api)
    for n in ("Uno", "Dos", "Tres"):
        api.post("/contacts", json={"name": n, "relation": "Amigo", "phone": "3000000000"}, headers=h)
    cs = api.get("/contacts", headers=h).json()
    assert [c["name"] for c in cs] == ["Uno", "Dos", "Tres"]
    out = api.put(f"/contacts/{cs[2]['id']}", json={"name": "Tres b", "relation": "Amigo", "phone": "3000000000"}, headers=h).json()
    assert [c["name"] for c in out] == ["Uno", "Dos", "Tres b"]


def test_contacto_principal(api):
    h = reg(api)
    for n in ("Uno", "Dos"):
        api.post("/contacts", json={"name": n, "relation": "Amigo", "phone": "3000000000"}, headers=h)
    out = api.post("/contacts", json={"name": "Jefe", "relation": "Amigo", "phone": "3000000000", "primary": True}, headers=h).json()
    assert [c["name"] for c in out] == ["Jefe", "Uno", "Dos"]


# ── Alertas de choque ──
def test_flujo_estoy_bien(api):
    h = reg(api)
    ev = crash(api, h, peak_g=42.5)
    assert ev["status"] == "preliminar" and ev["expires_at"] > time.time()
    assert "Sensor del casco" in ev["timeline"][0]["detail"] and "42.5" in ev["timeline"][0]["detail"]
    r = api.post(f"/events/{ev['id']}/resolve", json={"status": "descartada", "reason": "user_ok"}, headers=h).json()
    assert r["status"] == "descartada"
    assert api.get("/events?kind=sent", headers=h).json() == []


def test_resolver_es_idempotente_y_no_duplica_avisos(api):
    h = reg(api)
    api.post("/contacts", json={"name": "Mamá", "relation": "Familia", "phone": "3000000000"}, headers=h)
    ev = crash(api, h)
    for _ in range(3):
        r = api.post(f"/events/{ev['id']}/resolve", json={"status": "notificada", "reason": "user_confirmed"}, headers=h)
        assert r.status_code == 200 and r.json()["status"] == "notificada"
    assert len(api.get("/events?kind=sent", headers=h).json()) == 1


def test_no_se_puede_cambiar_una_alerta_ya_resuelta(api):
    h = reg(api)
    ev = crash(api, h)
    api.post(f"/events/{ev['id']}/resolve", json={"status": "descartada"}, headers=h)
    r = api.post(f"/events/{ev['id']}/resolve", json={"status": "notificada"}, headers=h)
    assert r.status_code == 409
    assert api.get(f"/events/{ev['id']}", headers=h).json()["status"] == "descartada"


def test_servidor_escala_alertas_vencidas(api):
    h = reg(api)
    api.post("/contacts", json={"name": "Mamá", "relation": "Familia", "phone": "3000000000"}, headers=h)
    ev = crash(api, h, countdown_s=10)
    assert [e["id"] for e in api.get("/events/active", headers=h).json()["events"]] == [ev["id"]]
    with api.main.db() as c:  # simula que ya pasó la cuenta regresiva y la gracia
        c.execute("UPDATE events SET expires_at=? WHERE id=?", (time.time() - 60, ev["id"]))
    assert api.get("/events/active", headers=h).json()["events"] == []
    got = api.get(f"/events/{ev['id']}", headers=h).json()
    assert got["status"] == "notificada" and len(got["contacts"]) == 1
    assert len(api.get("/events?kind=sent", headers=h).json()) == 1


def test_alerta_sin_contactos_lo_dice(api):
    h = reg(api)
    ev = crash(api, h)
    r = api.post(f"/events/{ev['id']}/resolve", json={"status": "notificada", "reason": "timeout"}, headers=h).json()
    assert any(s["label"] == "Aviso no enviado" for s in r["timeline"])


def test_deduplicacion_por_client_id(api):
    h = reg(api)
    a = crash(api, h, client_id="aa:bb:1:7")
    b = crash(api, h, client_id="aa:bb:1:7")
    assert a["id"] == b["id"] and len(api.get("/events", headers=h).json()) == 1


def test_choque_siempre_nace_preliminar(api):
    h = reg(api)
    ev = crash(api, h, status="notificada")
    assert ev["status"] == "preliminar"


def test_no_se_puede_usar_el_recorrido_de_otro(api):
    a, b = reg(api, "a@x.co"), reg(api, "b@x.co")
    t = api.post("/trips", headers=a).json()
    r = api.post("/events", json={"kind": "system", "severity": "info", "trip_id": t["id"]}, headers=b)
    assert r.status_code == 404


def test_limit_de_eventos_tiene_tope(api):
    h = reg(api)
    assert api.get("/events?limit=100000", headers=h).status_code == 422


# ── Recorridos ──
def test_ruta_larga_conserva_inicio_y_fin(api):
    h = reg(api)
    t = api.post("/trips", headers=h).json()
    pts = [{"lat": 4.6 + i * 1e-5, "lon": -74.0, "speed": 10, "t": i} for i in range(3000)]
    out = api.post(f"/trips/{t['id']}/finish", json={"distance_km": 10, "duration_s": 3600, "max_kmh": 30, "route": pts}, headers=h).json()
    assert len(out["route"]) == 2000
    assert out["route"][0]["lat"] == pts[0]["lat"] and out["route"][-1]["lat"] == pts[-1]["lat"]


def test_no_se_finaliza_dos_veces_y_valida_rangos(api):
    h = reg(api)
    t = api.post("/trips", headers=h).json()
    assert api.post(f"/trips/{t['id']}/finish", json={"max_kmh": 9999}, headers=h).status_code == 422
    assert api.post(f"/trips/{t['id']}/finish", json={"distance_km": 1, "duration_s": 600}, headers=h).status_code == 200
    assert api.post(f"/trips/{t['id']}/finish", json={"distance_km": 1, "duration_s": 600}, headers=h).status_code == 409


def test_borrar_recorrido_borra_sus_eventos(api):
    h = reg(api)
    t = api.post("/trips", headers=h).json()
    crash(api, h, trip_id=t["id"])
    api.delete(f"/trips/{t['id']}", headers=h)
    assert api.get("/events", headers=h).json() == []


def test_seed_es_idempotente(api):
    h = reg(api)
    assert api.post("/demo/seed", headers=h).json()["seeded"] is True
    n = len(api.get("/trips", headers=h).json())
    assert api.post("/demo/seed", headers=h).json()["seeded"] is False
    assert len(api.get("/trips", headers=h).json()) == n


def test_migracion_de_base_antigua(tmp_path, monkeypatch):
    """Una base creada con la v0.1 (sin columnas nuevas) se actualiza sin perder datos."""
    import importlib
    import sqlite3
    import sys

    path = str(tmp_path / "old.db")
    con = sqlite3.connect(path)
    con.executescript("""
      CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        pw_hash TEXT NOT NULL, salt TEXT NOT NULL, helmet TEXT DEFAULT 'SafeRide-H01', settings TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL);
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, trip_id INTEGER, kind TEXT NOT NULL,
        severity TEXT NOT NULL, status TEXT NOT NULL, ts REAL NOT NULL, place TEXT DEFAULT '', lat REAL, lon REAL, note TEXT DEFAULT '', timeline TEXT DEFAULT '[]');
      INSERT INTO users(email,name,pw_hash,salt,created) VALUES('v@x.co','Viejo','x','y',1);
      INSERT INTO events(user_id,kind,severity,status,ts) VALUES(1,'impact','alta','preliminar',1);
    """)
    con.commit(); con.close()
    monkeypatch.setenv("SAFERIDE_DB", path)
    monkeypatch.setenv("SAFERIDE_SECRET", "s")
    sys.modules.pop("main", None)
    main = importlib.import_module("main")
    main.init_db(); main.init_db()  # dos veces: debe ser repetible
    with main.db() as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(events)")}
        assert {"source", "client_id", "peak_g", "expires_at"} <= cols
        assert c.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
