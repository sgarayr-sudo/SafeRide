"""SafeRide API – FastAPI + SQLite + JWT.

Ejecutar:  uvicorn main:app --host 0.0.0.0 --port 8000
"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional

import jwt
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("SAFERIDE_DB", os.path.join(os.path.dirname(__file__), "saferide.db"))
SECRET = os.environ.get("SAFERIDE_SECRET", "cambia-este-secreto-en-produccion")
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 días

app = FastAPI(title="SafeRide API", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
bearer = HTTPBearer(auto_error=False)


# ───────────────────────── Base de datos ─────────────────────────
@contextmanager
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db():
    with db() as c:
        c.executescript(
            """
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL, pw_hash TEXT NOT NULL, salt TEXT NOT NULL,
          helmet TEXT DEFAULT 'SafeRide-H01', settings TEXT NOT NULL DEFAULT '{}',
          created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS contacts(
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL, relation TEXT NOT NULL, phone TEXT NOT NULL, priority INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS trips(
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          started REAL NOT NULL, ended REAL, distance_km REAL DEFAULT 0, duration_s INTEGER DEFAULT 0,
          avg_kmh REAL DEFAULT 0, max_kmh REAL DEFAULT 0, route TEXT DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          trip_id INTEGER, kind TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
          ts REAL NOT NULL, place TEXT DEFAULT '', lat REAL, lon REAL, note TEXT DEFAULT '', timeline TEXT DEFAULT '[]');
        """
        )


init_db()

DEFAULT_SETTINGS = {
    "location": True, "notifications": True, "bluetooth": True,
    "sensitivity": 1,  # 0 bajo, 1 medio, 2 alto
    "helmet_demo": False, "buzzer": True, "phone_sound": True, "share_location": True, "save_history": True,
}


# ───────────────────────── Auth ─────────────────────────
def hash_pw(pw: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000).hex()


def make_token(uid: int) -> str:
    return jwt.encode({"sub": str(uid), "exp": int(time.time()) + TOKEN_TTL}, SECRET, algorithm="HS256")


def current_user(cred: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> sqlite3.Row:
    if not cred:
        raise HTTPException(401, "No autenticado")
    try:
        uid = int(jwt.decode(cred.credentials, SECRET, algorithms=["HS256"])["sub"])
    except Exception:
        raise HTTPException(401, "Sesión inválida o expirada")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise HTTPException(401, "Usuario no existe")
    return u


def user_out(u) -> dict:
    s = {**DEFAULT_SETTINGS, **json.loads(u["settings"])}
    return {"id": u["id"], "email": u["email"], "name": u["name"], "helmet": u["helmet"], "settings": s}


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=6, max_length=100)


class LoginIn(BaseModel):
    email: str
    password: str


@app.get("/health")
def health():
    return {"ok": True, "service": "saferide"}


@app.post("/auth/register")
def register(b: RegisterIn):
    email = b.email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(422, "Correo no válido")
    salt = secrets.token_hex(8)
    try:
        with db() as c:
            cur = c.execute(
                "INSERT INTO users(email,name,pw_hash,salt,settings,created) VALUES(?,?,?,?,?,?)",
                (email, b.name.strip(), hash_pw(b.password, salt), salt, json.dumps(DEFAULT_SETTINGS), time.time()),
            )
            uid = cur.lastrowid
            u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Ese correo ya está registrado")
    return {"token": make_token(uid), "user": user_out(u)}


@app.post("/auth/login")
def login(b: LoginIn):
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE email=?", (b.email.strip().lower(),)).fetchone()
    if not u or not hmac.compare_digest(u["pw_hash"], hash_pw(b.password, u["salt"])):
        raise HTTPException(401, "Correo o contraseña incorrectos")
    return {"token": make_token(u["id"]), "user": user_out(u)}


@app.get("/me")
def me(u=Depends(current_user)):
    return user_out(u)


class ProfileIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    helmet: Optional[str] = None
    settings: Optional[dict] = None


@app.put("/me")
def update_me(b: ProfileIn, u=Depends(current_user)):
    cur = {**DEFAULT_SETTINGS, **json.loads(u["settings"])}
    if b.settings:
        cur.update({k: v for k, v in b.settings.items() if k in DEFAULT_SETTINGS})
    with db() as c:
        c.execute(
            "UPDATE users SET name=?, helmet=?, settings=? WHERE id=?",
            (b.name or u["name"], b.helmet or u["helmet"], json.dumps(cur), u["id"]),
        )
        u2 = c.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    return user_out(u2)


# ───────────────────────── Contactos ─────────────────────────
class ContactIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    relation: str = Field(min_length=1, max_length=40)
    phone: str = Field(min_length=7, max_length=25)
    priority: int = Field(default=1, ge=1, le=9)
    primary: bool = False


def contacts_of(c, uid):
    return [dict(r) for r in c.execute("SELECT * FROM contacts WHERE user_id=? ORDER BY priority,id", (uid,))]


def normalize(c, uid):
    """Reordena prioridades 1..n sin huecos."""
    for i, r in enumerate(contacts_of(c, uid), 1):
        c.execute("UPDATE contacts SET priority=? WHERE id=?", (i, r["id"]))


def place(c, uid, cid, priority):
    """Inserta el contacto cid en la posición `priority` desplazando los demás."""
    others = [r["id"] for r in contacts_of(c, uid) if r["id"] != cid]
    pos = max(1, min(priority, len(others) + 1))
    others.insert(pos - 1, cid)
    for i, i_id in enumerate(others, 1):
        c.execute("UPDATE contacts SET priority=? WHERE id=?", (i, i_id))


@app.get("/contacts")
def list_contacts(u=Depends(current_user)):
    with db() as c:
        return contacts_of(c, u["id"])


@app.post("/contacts")
def add_contact(b: ContactIn, u=Depends(current_user)):
    with db() as c:
        n = len(contacts_of(c, u["id"]))
        cur = c.execute(
            "INSERT INTO contacts(user_id,name,relation,phone,priority) VALUES(?,?,?,?,?)",
            (u["id"], b.name.strip(), b.relation, b.phone.strip(), n + 1),
        )
        place(c, u["id"], cur.lastrowid, 1 if b.primary else b.priority)
        return contacts_of(c, u["id"])


@app.put("/contacts/{cid}")
def edit_contact(cid: int, b: ContactIn, u=Depends(current_user)):
    with db() as c:
        if not c.execute("SELECT 1 FROM contacts WHERE id=? AND user_id=?", (cid, u["id"])).fetchone():
            raise HTTPException(404, "Contacto no encontrado")
        c.execute("UPDATE contacts SET name=?,relation=?,phone=? WHERE id=?", (b.name.strip(), b.relation, b.phone.strip(), cid))
        place(c, u["id"], cid, 1 if b.primary else b.priority)
        return contacts_of(c, u["id"])


@app.post("/contacts/{cid}/primary")
def make_primary(cid: int, u=Depends(current_user)):
    with db() as c:
        if not c.execute("SELECT 1 FROM contacts WHERE id=? AND user_id=?", (cid, u["id"])).fetchone():
            raise HTTPException(404, "Contacto no encontrado")
        place(c, u["id"], cid, 1)
        return contacts_of(c, u["id"])


@app.delete("/contacts/{cid}")
def del_contact(cid: int, u=Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM contacts WHERE id=? AND user_id=?", (cid, u["id"]))
        normalize(c, u["id"])
        return contacts_of(c, u["id"])


# ───────────────────────── Recorridos ─────────────────────────
class Point(BaseModel):
    lat: float
    lon: float
    speed: float = 0  # km/h
    t: float = 0


class TripFinish(BaseModel):
    distance_km: float = 0
    duration_s: int = 0
    max_kmh: float = 0
    route: list[Point] = []


def trip_out(r, with_route=False):
    d = {k: r[k] for k in ("id", "started", "ended", "distance_km", "duration_s", "avg_kmh", "max_kmh")}
    if with_route:
        d["route"] = json.loads(r["route"])
    return d


@app.post("/trips")
def start_trip(u=Depends(current_user)):
    with db() as c:
        cur = c.execute("INSERT INTO trips(user_id,started) VALUES(?,?)", (u["id"], time.time()))
        return {"id": cur.lastrowid, "started": time.time()}


@app.post("/trips/{tid}/finish")
def finish_trip(tid: int, b: TripFinish, u=Depends(current_user)):
    with db() as c:
        t = c.execute("SELECT * FROM trips WHERE id=? AND user_id=?", (tid, u["id"])).fetchone()
        if not t:
            raise HTTPException(404, "Recorrido no encontrado")
        hours = max(b.duration_s, 1) / 3600
        avg = round(b.distance_km / hours, 1) if b.duration_s > 0 else 0
        route = [p.model_dump() for p in b.route][:2000]
        c.execute(
            "UPDATE trips SET ended=?,distance_km=?,duration_s=?,avg_kmh=?,max_kmh=?,route=? WHERE id=?",
            (time.time(), round(b.distance_km, 2), b.duration_s, avg, round(b.max_kmh, 1), json.dumps(route), tid),
        )
        r = c.execute("SELECT * FROM trips WHERE id=?", (tid,)).fetchone()
        out = trip_out(r, True)
        out["events"] = [event_out(e) for e in c.execute("SELECT * FROM events WHERE trip_id=? ORDER BY ts", (tid,))]
        return out


@app.get("/trips")
def list_trips(days: Optional[int] = None, u=Depends(current_user)):
    q, a = "SELECT * FROM trips WHERE user_id=? AND ended IS NOT NULL", [u["id"]]
    if days:
        q += " AND started>=?"
        a.append(time.time() - days * 86400)
    with db() as c:
        out = []
        for r in c.execute(q + " ORDER BY started DESC", a):
            d = trip_out(r)
            d["events"] = c.execute("SELECT COUNT(*) FROM events WHERE trip_id=?", (r["id"],)).fetchone()[0]
            out.append(d)
        return out


@app.get("/trips/{tid}")
def get_trip(tid: int, u=Depends(current_user)):
    with db() as c:
        r = c.execute("SELECT * FROM trips WHERE id=? AND user_id=?", (tid, u["id"])).fetchone()
        if not r:
            raise HTTPException(404, "Recorrido no encontrado")
        d = trip_out(r, True)
        d["events"] = [event_out(e) for e in c.execute("SELECT * FROM events WHERE trip_id=? ORDER BY ts", (tid,))]
        return d


@app.delete("/trips/{tid}")
def del_trip(tid: int, u=Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM trips WHERE id=? AND user_id=?", (tid, u["id"]))
    return {"ok": True}


# ───────────────────────── Eventos / alertas ─────────────────────────
class EventIn(BaseModel):
    kind: str = Field(pattern="^(impact|fall|sent|system)$")
    severity: str = Field(default="media", pattern="^(alta|media|baja|info)$")
    status: str = "preliminar"  # preliminar | notificada | descartada
    place: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None
    trip_id: Optional[int] = None
    note: str = ""


class EventPatch(BaseModel):
    status: str = Field(pattern="^(preliminar|notificada|descartada)$")
    note: str = ""


def event_out(r):
    d = dict(r)
    d["timeline"] = json.loads(d["timeline"] or "[]")
    return d


def step(label, detail, done=True):
    return {"label": label, "detail": detail, "done": done, "ts": time.time()}


@app.post("/events")
def create_event(b: EventIn, u=Depends(current_user)):
    tl = [step("Impacto detectado", "Sensor del casco")] if b.kind in ("fall", "impact") else []
    with db() as c:
        cur = c.execute(
            "INSERT INTO events(user_id,trip_id,kind,severity,status,ts,place,lat,lon,note,timeline) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (u["id"], b.trip_id, b.kind, b.severity, b.status, time.time(), b.place, b.lat, b.lon, b.note, json.dumps(tl)),
        )
        return event_out(c.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone())


@app.get("/events")
def list_events(kind: Optional[str] = None, status: Optional[str] = None, limit: int = 100, u=Depends(current_user)):
    q, a = "SELECT * FROM events WHERE user_id=?", [u["id"]]
    if kind:
        q += " AND kind=?"
        a.append(kind)
    if status:
        q += " AND status=?"
        a.append(status)
    with db() as c:
        return [event_out(r) for r in c.execute(q + " ORDER BY ts DESC LIMIT ?", a + [limit])]


@app.get("/events/{eid}")
def get_event(eid: int, u=Depends(current_user)):
    with db() as c:
        r = c.execute("SELECT * FROM events WHERE id=? AND user_id=?", (eid, u["id"])).fetchone()
        if not r:
            raise HTTPException(404, "Evento no encontrado")
        d = event_out(r)
        d["contacts"] = contacts_of(c, u["id"]) if r["status"] == "notificada" else []
        return d


@app.post("/events/{eid}/resolve")
def resolve_event(eid: int, b: EventPatch, u=Depends(current_user)):
    """'Estoy bien' → descartada. 'Confirmar emergencia' / cuenta regresiva agotada → notificada
    (se registra el aviso a los contactos personales; no se contacta a servicios oficiales)."""
    with db() as c:
        r = c.execute("SELECT * FROM events WHERE id=? AND user_id=?", (eid, u["id"])).fetchone()
        if not r:
            raise HTTPException(404, "Evento no encontrado")
        tl = json.loads(r["timeline"] or "[]")
        if b.status == "descartada":
            tl.append(step("Descartada", 'El ciclista indicó: "Estoy bien"'))
        elif b.status == "notificada":
            n = len(contacts_of(c, u["id"]))
            tl.append(step("Cuenta regresiva sin respuesta", "30 s · el ciclista no respondió"))
            tl.append(step("Notificación enviada", f"{n} contactos personales"))
            tl.append(step("Confirmación de un contacto", "Pendiente", done=False))
            c.execute(
                "INSERT INTO events(user_id,trip_id,kind,severity,status,ts,place,lat,lon,note,timeline) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (u["id"], r["trip_id"], "sent", "alta", "notificada", time.time(), r["place"], r["lat"], r["lon"],
                 f"Aviso enviado a {n} contactos", "[]"),
            )
        c.execute("UPDATE events SET status=?, note=?, timeline=? WHERE id=?", (b.status, b.note or r["note"], json.dumps(tl), eid))
        return event_out(c.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone())


@app.delete("/events/{eid}")
def del_event(eid: int, u=Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM events WHERE id=? AND user_id=?", (eid, u["id"]))
    return {"ok": True}


# ───────────────────────── Datos de demostración ─────────────────────────
def seed_data(c, u):
    now = time.time()
    day = 86400
    if True:
        if not contacts_of(c, u["id"]):
            for i, (n, r, p) in enumerate([("María Fernanda Ríos", "Madre o padre", "+57 300 000 0101"),
                                           ("Andrés Gómez", "Hermano/a", "+57 300 000 0102"),
                                           ("Laura Pérez", "Amigo/a", "+57 300 000 0103")], 1):
                c.execute("INSERT INTO contacts(user_id,name,relation,phone,priority) VALUES(?,?,?,?,?)", (u["id"], n, r, p, i))
        base_lat, base_lon = 4.6486, -74.0628
        specs = [(1, 32, 5.8, 1), (2, 48, 9.3, 0), (4, 27, 4.7, 2), (8, 72, 16.4, 0), (12, 35, 6.1, 1), (22, 41, 7.2, 0)]
        for days_ago, mins, dist, n_ev in specs:
            start = now - days_ago * day - 3600
            route = [{"lat": base_lat + 0.0009 * i * (1 if i % 4 < 2 else 0.2), "lon": base_lon + 0.0011 * i * (1 if i % 4 >= 2 else 0.3), "speed": 12 + (i % 5), "t": start + i * 60} for i in range(20)]
            cur = c.execute(
                "INSERT INTO trips(user_id,started,ended,distance_km,duration_s,avg_kmh,max_kmh,route) VALUES(?,?,?,?,?,?,?,?)",
                (u["id"], start, start + mins * 60, dist, mins * 60, round(dist / (mins / 60), 1), 26, json.dumps(route)))
            for k in range(n_ev):
                c.execute(
                    "INSERT INTO events(user_id,trip_id,kind,severity,status,ts,place,lat,lon,note,timeline) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (u["id"], cur.lastrowid, "impact", "media" if k == 0 else "baja", "preliminar", start + (10 + 5 * k) * 60,
                     "Usaquén (aprox.)", route[8]["lat"], route[8]["lon"], "Detección preliminar sin confirmar", "[]"))


@app.post("/demo/seed")
def seed(u=Depends(current_user)):
    """Carga contactos, recorridos y eventos de ejemplo en la cuenta (solo para pruebas)."""
    with db() as c:
        seed_data(c, u)
    return {"ok": True}


DEMO_EMAIL, DEMO_PASS = "demo@saferide.app", "demo1234"


def ensure_demo_user():
    """Cuenta de demostración siempre disponible (útil si el hosting gratuito borra la base de datos)."""
    with db() as c:
        if c.execute("SELECT 1 FROM users WHERE email=?", (DEMO_EMAIL,)).fetchone():
            return
        salt = secrets.token_hex(8)
        cur = c.execute("INSERT INTO users(email,name,pw_hash,salt,settings,created) VALUES(?,?,?,?,?,?)",
                        (DEMO_EMAIL, "Ciclista Demo", hash_pw(DEMO_PASS, salt), salt,
                         json.dumps({**DEFAULT_SETTINGS, "helmet_demo": True}), time.time()))
        seed_data(c, c.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone())


ensure_demo_user()
