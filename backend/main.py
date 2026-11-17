"""SafeRide API – FastAPI + SQLite + JWT.

Ejecutar:  uvicorn main:app --host 0.0.0.0 --port 8000

Variables de entorno
  SAFERIDE_SECRET   Clave para firmar los JWT. Obligatoria en producción. Si no existe se
                    genera una al azar y se guarda en backend/.saferide_secret (solo desarrollo).
  SAFERIDE_DB       Ruta del archivo SQLite (por defecto backend/saferide.db).
  SAFERIDE_DEMO     "1" (por defecto) crea la cuenta demo@saferide.app; "0" la desactiva.
  SAFERIDE_CORS     Orígenes permitidos separados por coma (por defecto "*").
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager
from typing import Optional

import jwt
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

log = logging.getLogger("saferide")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SAFERIDE_DB", os.path.join(BASE_DIR, "saferide.db"))
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 días
PBKDF2_ITERS = 200_000
ESCALATION_GRACE_S = 5          # margen para que la app responda antes de que el servidor escale
ESCALATION_POLL_S = 5           # cada cuánto revisa el servidor las alertas vencidas
DEMO_EMAIL, DEMO_PASS = "demo@saferide.app", "demo1234"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def load_secret() -> str:
    """Nunca hay una clave por defecto conocida: o viene del entorno o se genera una local."""
    env = os.environ.get("SAFERIDE_SECRET")
    if env:
        return env
    path = os.path.join(BASE_DIR, ".saferide_secret")
    try:
        with open(path) as f:
            s = f.read().strip()
            if s:
                return s
    except FileNotFoundError:
        pass
    s = secrets.token_urlsafe(48)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(s)
    except OSError:
        log.warning("No se pudo guardar la clave local; los tokens se invalidarán al reiniciar.")
    log.warning("SAFERIDE_SECRET no definida: usando clave local de desarrollo. Define SAFERIDE_SECRET en producción.")
    return s


SECRET = load_secret()


# ───────────────────────── Base de datos ─────────────────────────
@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


SCHEMA = """
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

# Columnas añadidas después de la v0.1: se agregan a bases existentes sin perder datos.
EVENT_COLUMNS = {
    "source": "TEXT NOT NULL DEFAULT 'phone'",   # helmet | phone | manual | system
    "client_id": "TEXT",                           # id único del origen (deduplicación)
    "peak_g": "REAL",                              # fuerza pico reportada por el casco
    "expires_at": "REAL",                          # fin de la cuenta regresiva (la hace cumplir el servidor)
}


def init_db():
    with db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        have = {r["name"] for r in c.execute("PRAGMA table_info(events)")}
        for col, ddl in EVENT_COLUMNS.items():
            if col not in have:
                c.execute(f"ALTER TABLE events ADD COLUMN {col} {ddl}")
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_trip ON events(trip_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_pending ON events(status, expires_at)")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_events_client ON events(user_id, client_id) WHERE client_id IS NOT NULL")


DEFAULT_SETTINGS = {
    "location": True, "notifications": True, "bluetooth": True,
    "sensitivity": 1,  # 0 bajo, 1 medio, 2 alto
    "helmet_demo": False, "buzzer": True, "phone_sound": True, "share_location": True, "save_history": True,
}


def clean_settings(raw: dict) -> dict:
    """Solo claves conocidas y con el tipo correcto."""
    out = {}
    for k, v in raw.items():
        if k not in DEFAULT_SETTINGS:
            continue
        if k == "sensitivity":
            if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2:
                out[k] = v
        elif isinstance(v, bool):
            out[k] = v
    return out


# ───────────────────────── Auth ─────────────────────────
def hash_pw(pw: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), PBKDF2_ITERS).hex()


DUMMY_SALT = secrets.token_hex(8)
DUMMY_HASH = hash_pw("dummy", DUMMY_SALT)


def make_token(uid: int) -> str:
    return jwt.encode({"sub": str(uid), "exp": int(time.time()) + TOKEN_TTL}, SECRET, algorithm="HS256")


bearer = HTTPBearer(auto_error=False)


def current_user(cred: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> sqlite3.Row:
    if not cred:
        raise HTTPException(401, "No autenticado")
    try:
        uid = int(jwt.decode(cred.credentials, SECRET, algorithms=["HS256"])["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(401, "Sesión inválida o expirada")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise HTTPException(401, "Usuario no existe")
    return u


def user_out(u) -> dict:
    s = {**DEFAULT_SETTINGS, **json.loads(u["settings"])}
    return {"id": u["id"], "email": u["email"], "name": u["name"], "helmet": u["helmet"], "settings": s}


# Límite simple de intentos fallidos de login (en memoria; suficiente para un solo proceso).
LOGIN_WINDOW_S, LOGIN_MAX_FAILS = 300, 8
_login_fails: dict = defaultdict(deque)


def _check_login_rate(key: str):
    q = _login_fails[key]
    while q and q[0] < time.time() - LOGIN_WINDOW_S:
        q.popleft()
    if len(q) >= LOGIN_MAX_FAILS:
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.")


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=6, max_length=100)


class LoginIn(BaseModel):
    email: str = Field(max_length=120)
    password: str = Field(max_length=100)


# ───────────────────────── Alertas: lógica compartida ─────────────────────────
def step(label, detail, done=True):
    return {"label": label, "detail": detail, "done": done, "ts": time.time()}


def contacts_of(c, uid):
    return [dict(r) for r in c.execute("SELECT * FROM contacts WHERE user_id=? ORDER BY priority,id", (uid,))]


def event_out(r):
    d = dict(r)
    d["timeline"] = json.loads(d["timeline"] or "[]")
    return d


def notify_event(c, event_row, reason: str) -> bool:
    """Pasa un evento preliminar a 'notificada' una sola vez (seguro ante carreras).

    reason: user_confirmed | timeout | server_timeout. Devuelve True si esta llamada hizo la transición.
    NOTA: el prototipo solo REGISTRA el aviso a los contactos; no envía SMS ni push.
    """
    uid = event_row["user_id"]
    n = len(contacts_of(c, uid))
    tl = json.loads(event_row["timeline"] or "[]")
    if reason == "user_confirmed":
        tl.append(step("Emergencia confirmada", "El ciclista pidió avisar a sus contactos"))
    elif reason == "server_timeout":
        tl.append(step("Cuenta regresiva vencida", "Sin respuesta; el servidor escaló la alerta"))
    else:
        tl.append(step("Cuenta regresiva sin respuesta", "El ciclista no respondió a tiempo"))
    if n:
        tl.append(step("Aviso registrado", f"{n} contacto(s) · registro en el prototipo, sin envío de SMS/push"))
    else:
        tl.append(step("Aviso no enviado", "No hay contactos registrados"))
    cur = c.execute("UPDATE events SET status='notificada', timeline=? WHERE id=? AND status='preliminar'",
                    (json.dumps(tl), event_row["id"]))
    if cur.rowcount != 1:
        return False
    note = f"Aviso registrado para {n} contactos" if n else "Aviso sin contactos registrados"
    c.execute(
        "INSERT INTO events(user_id,trip_id,kind,severity,status,ts,place,lat,lon,note,timeline,source) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (uid, event_row["trip_id"], "sent", "alta", "notificada", time.time(), event_row["place"],
         event_row["lat"], event_row["lon"], note, "[]", "system"),
    )
    return True


def escalate_expired(user_id: Optional[int] = None) -> int:
    """Escala las alertas cuya cuenta regresiva venció. Se ejecuta en segundo plano y,
    además, al consultar eventos, para que el resultado sea correcto aunque el proceso haya dormido."""
    q = "SELECT * FROM events WHERE status='preliminar' AND expires_at IS NOT NULL AND expires_at<=?"
    args: list = [time.time() - ESCALATION_GRACE_S]
    if user_id is not None:
        q += " AND user_id=?"
        args.append(user_id)
    done = 0
    with db() as c:
        for r in c.execute(q, args).fetchall():
            if notify_event(c, r, "server_timeout"):
                done += 1
    return done


async def _escalation_loop():
    while True:
        try:
            await asyncio.to_thread(escalate_expired)
        except Exception:  # el bucle nunca debe morir
            log.exception("Error escalando alertas vencidas")
        await asyncio.sleep(ESCALATION_POLL_S)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    if os.environ.get("SAFERIDE_DEMO", "1") == "1":
        ensure_demo_user()
    task = asyncio.create_task(_escalation_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="SafeRide API", version="0.2", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("SAFERIDE_CORS", "*").split(",") if o.strip()],
    allow_methods=["*"], allow_headers=["*"],
)


# ───────────────────────── Auth / perfil ─────────────────────────
@app.get("/health")
def health():
    return {"ok": True, "service": "saferide", "version": app.version}


@app.post("/auth/register")
def register(b: RegisterIn):
    email = b.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Correo no válido")
    salt = secrets.token_hex(16)
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
    email = b.email.strip().lower()
    _check_login_rate(email)
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    # Se calcula el hash siempre, para que el tiempo de respuesta no revele si el correo existe.
    ok = hmac.compare_digest(
        (u["pw_hash"] if u else DUMMY_HASH), hash_pw(b.password, u["salt"] if u else DUMMY_SALT)
    ) and u is not None
    if not ok:
        _login_fails[email].append(time.time())
        raise HTTPException(401, "Correo o contraseña incorrectos")
    _login_fails.pop(email, None)
    return {"token": make_token(u["id"]), "user": user_out(u)}


@app.get("/me")
def me(u=Depends(current_user)):
    return user_out(u)


class ProfileIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    helmet: Optional[str] = Field(default=None, min_length=1, max_length=40)
    settings: Optional[dict] = None


@app.put("/me")
def update_me(b: ProfileIn, u=Depends(current_user)):
    cur = {**DEFAULT_SETTINGS, **json.loads(u["settings"])}
    if b.settings:
        cur.update(clean_settings(b.settings))
    with db() as c:
        c.execute(
            "UPDATE users SET name=?, helmet=?, settings=? WHERE id=?",
            (b.name.strip() if b.name else u["name"], b.helmet or u["helmet"], json.dumps(cur), u["id"]),
        )
        u2 = c.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    return user_out(u2)


# ───────────────────────── Contactos ─────────────────────────
class ContactIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    relation: str = Field(min_length=1, max_length=40)
    phone: str = Field(min_length=7, max_length=25)
    priority: Optional[int] = Field(default=None, ge=1, le=99)  # None = no cambiar / ir al final
    primary: bool = False


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
        target = 1 if b.primary else (b.priority or n + 1)
        place(c, u["id"], cur.lastrowid, target)
        return contacts_of(c, u["id"])


@app.put("/contacts/{cid}")
def edit_contact(cid: int, b: ContactIn, u=Depends(current_user)):
    with db() as c:
        if not c.execute("SELECT 1 FROM contacts WHERE id=? AND user_id=?", (cid, u["id"])).fetchone():
            raise HTTPException(404, "Contacto no encontrado")
        c.execute("UPDATE contacts SET name=?,relation=?,phone=? WHERE id=?",
                  (b.name.strip(), b.relation, b.phone.strip(), cid))
        if b.primary:
            place(c, u["id"], cid, 1)
        elif b.priority is not None:
            place(c, u["id"], cid, b.priority)
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
MAX_ROUTE_POINTS = 2000


class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    speed: float = Field(default=0, ge=0, le=300)  # km/h
    t: float = 0


class TripFinish(BaseModel):
    distance_km: float = Field(default=0, ge=0, le=5000)
    duration_s: int = Field(default=0, ge=0, le=60 * 60 * 48)
    max_kmh: float = Field(default=0, ge=0, le=300)
    route: list[Point] = Field(default_factory=list, max_length=20000)


def downsample(points: list, limit: int = MAX_ROUTE_POINTS) -> list:
    """Reduce la ruta a `limit` puntos conservando el primero y el último."""
    n = len(points)
    if n <= limit:
        return points
    idx = {round(i * (n - 1) / (limit - 1)) for i in range(limit)}
    return [points[i] for i in sorted(idx)]


def trip_out(r, with_route=False):
    d = {k: r[k] for k in ("id", "started", "ended", "distance_km", "duration_s", "avg_kmh", "max_kmh")}
    if with_route:
        d["route"] = json.loads(r["route"])
    return d


def events_of_trip(c, tid, uid):
    return [event_out(e) for e in c.execute("SELECT * FROM events WHERE trip_id=? AND user_id=? ORDER BY ts", (tid, uid))]


@app.post("/trips")
def start_trip(u=Depends(current_user)):
    now = time.time()
    with db() as c:
        cur = c.execute("INSERT INTO trips(user_id,started) VALUES(?,?)", (u["id"], now))
        return {"id": cur.lastrowid, "started": now}


@app.post("/trips/{tid}/finish")
def finish_trip(tid: int, b: TripFinish, u=Depends(current_user)):
    with db() as c:
        t = c.execute("SELECT * FROM trips WHERE id=? AND user_id=?", (tid, u["id"])).fetchone()
        if not t:
            raise HTTPException(404, "Recorrido no encontrado")
        if t["ended"] is not None:
            raise HTTPException(409, "El recorrido ya estaba finalizado")
        avg = round(b.distance_km / (b.duration_s / 3600), 1) if b.duration_s > 0 else 0
        route = downsample([p.model_dump() for p in b.route])
        c.execute(
            "UPDATE trips SET ended=?,distance_km=?,duration_s=?,avg_kmh=?,max_kmh=?,route=? WHERE id=?",
            (time.time(), round(b.distance_km, 2), b.duration_s, avg, round(b.max_kmh, 1), json.dumps(route), tid),
        )
        out = trip_out(c.execute("SELECT * FROM trips WHERE id=?", (tid,)).fetchone(), True)
        out["events"] = events_of_trip(c, tid, u["id"])
        return out


@app.get("/trips")
def list_trips(days: Optional[int] = Query(default=None, ge=1, le=3650), u=Depends(current_user)):
    q, a = "SELECT * FROM trips WHERE user_id=? AND ended IS NOT NULL", [u["id"]]
    if days:
        q += " AND started>=?"
        a.append(time.time() - days * 86400)
    with db() as c:
        out = []
        for r in c.execute(q + " ORDER BY started DESC", a).fetchall():
            d = trip_out(r)
            d["events"] = c.execute("SELECT COUNT(*) FROM events WHERE trip_id=? AND user_id=?", (r["id"], u["id"])).fetchone()[0]
            out.append(d)
        return out


@app.get("/trips/{tid}")
def get_trip(tid: int, u=Depends(current_user)):
    with db() as c:
        r = c.execute("SELECT * FROM trips WHERE id=? AND user_id=?", (tid, u["id"])).fetchone()
        if not r:
            raise HTTPException(404, "Recorrido no encontrado")
        d = trip_out(r, True)
        d["events"] = events_of_trip(c, tid, u["id"])
        return d


@app.delete("/trips/{tid}")
def del_trip(tid: int, u=Depends(current_user)):
    with db() as c:
        if c.execute("SELECT 1 FROM trips WHERE id=? AND user_id=?", (tid, u["id"])).fetchone():
            c.execute("DELETE FROM events WHERE trip_id=? AND user_id=?", (tid, u["id"]))
            c.execute("DELETE FROM trips WHERE id=? AND user_id=?", (tid, u["id"]))
    return {"ok": True}


# ───────────────────────── Eventos / alertas ─────────────────────────
class EventIn(BaseModel):
    kind: str = Field(pattern="^(impact|fall|sent|system)$")
    severity: str = Field(default="media", pattern="^(alta|media|baja|info)$")
    status: str = Field(default="preliminar", pattern="^(preliminar|notificada|descartada)$")
    source: str = Field(default="phone", pattern="^(helmet|phone|manual|system)$")
    client_id: Optional[str] = Field(default=None, min_length=1, max_length=80)  # deduplicación
    peak_g: Optional[float] = Field(default=None, ge=0, le=500)
    countdown_s: int = Field(default=30, ge=10, le=120)
    place: str = Field(default="", max_length=120)
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lon: Optional[float] = Field(default=None, ge=-180, le=180)
    trip_id: Optional[int] = None
    note: str = Field(default="", max_length=500)


class EventPatch(BaseModel):
    status: str = Field(pattern="^(descartada|notificada)$")
    reason: Optional[str] = Field(default=None, pattern="^(user_ok|user_confirmed|timeout)$")
    note: str = Field(default="", max_length=500)


DETECTION_LABEL = {
    "helmet": "Sensor del casco",
    "phone": "Detección en el teléfono",
    "manual": "Alerta manual del ciclista",
    "system": "Sistema",
}


@app.post("/events")
def create_event(b: EventIn, u=Depends(current_user)):
    is_crash = b.kind in ("fall", "impact")
    status = "preliminar" if is_crash else b.status  # los choques siempre empiezan preliminares
    expires_at = time.time() + b.countdown_s if is_crash else None
    tl = []
    if is_crash:
        detail = DETECTION_LABEL[b.source] + (f" · {b.peak_g:.1f} g" if b.peak_g is not None else "")
        tl.append(step("Impacto detectado", detail))
    with db() as c:
        if b.trip_id is not None and not c.execute(
            "SELECT 1 FROM trips WHERE id=? AND user_id=?", (b.trip_id, u["id"])
        ).fetchone():
            raise HTTPException(404, "Recorrido no encontrado")
        if b.client_id:  # idempotencia: el casco puede repetir la notificación BLE
            dup = c.execute("SELECT * FROM events WHERE user_id=? AND client_id=?", (u["id"], b.client_id)).fetchone()
            if dup:
                return event_out(dup)
        cur = c.execute(
            "INSERT INTO events(user_id,trip_id,kind,severity,status,ts,place,lat,lon,note,timeline,"
            "source,client_id,peak_g,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (u["id"], b.trip_id, b.kind, b.severity, status, time.time(), b.place, b.lat, b.lon, b.note,
             json.dumps(tl), b.source, b.client_id, b.peak_g, expires_at),
        )
        return event_out(c.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone())


@app.get("/events")
def list_events(
    kind: Optional[str] = None, status: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=500), u=Depends(current_user),
):
    escalate_expired(u["id"])
    q, a = "SELECT * FROM events WHERE user_id=?", [u["id"]]
    if kind:
        q += " AND kind=?"
        a.append(kind)
    if status:
        q += " AND status=?"
        a.append(status)
    with db() as c:
        return [event_out(r) for r in c.execute(q + " ORDER BY ts DESC LIMIT ?", a + [limit])]


@app.get("/events/active")
def active_events(u=Depends(current_user)):
    """Alertas de choque aún pendientes: la app las consulta al abrirse para retomar una cuenta regresiva."""
    escalate_expired(u["id"])
    with db() as c:
        rows = c.execute(
            "SELECT * FROM events WHERE user_id=? AND status='preliminar' AND expires_at IS NOT NULL "
            "AND kind IN ('impact','fall') ORDER BY ts DESC", (u["id"],)).fetchall()
        return {"now": time.time(), "events": [event_out(r) for r in rows]}


@app.get("/events/{eid}")
def get_event(eid: int, u=Depends(current_user)):
    escalate_expired(u["id"])
    with db() as c:
        r = c.execute("SELECT * FROM events WHERE id=? AND user_id=?", (eid, u["id"])).fetchone()
        if not r:
            raise HTTPException(404, "Evento no encontrado")
        d = event_out(r)
        d["contacts"] = contacts_of(c, u["id"]) if r["status"] == "notificada" else []
        return d


@app.post("/events/{eid}/resolve")
def resolve_event(eid: int, b: EventPatch, u=Depends(current_user)):
    """'Estoy bien' → descartada. 'Confirmar emergencia' / cuenta regresiva agotada → notificada.

    Solo se puede resolver un evento preliminar. Repetir la misma resolución es inofensivo (idempotente);
    pedir una resolución distinta a la ya registrada devuelve 409. Se registra el aviso a los contactos
    personales; no se contacta a servicios oficiales."""
    with db() as c:
        r = c.execute("SELECT * FROM events WHERE id=? AND user_id=?", (eid, u["id"])).fetchone()
        if not r:
            raise HTTPException(404, "Evento no encontrado")
        if r["kind"] not in ("impact", "fall"):
            raise HTTPException(409, "Solo los eventos de choque o caída se pueden resolver")
        if r["status"] != "preliminar":
            if r["status"] == b.status:
                return event_out(r)
            raise HTTPException(409, f"La alerta ya estaba {r['status']}")
        if b.status == "descartada":
            tl = json.loads(r["timeline"] or "[]")
            tl.append(step("Descartada", 'El ciclista indicó: "Estoy bien"'))
            c.execute("UPDATE events SET status='descartada', note=?, timeline=? WHERE id=? AND status='preliminar'",
                      (b.note or r["note"], json.dumps(tl), eid))
        else:
            notify_event(c, r, "user_confirmed" if b.reason == "user_confirmed" else "timeout")
            if b.note:
                c.execute("UPDATE events SET note=? WHERE id=?", (b.note, eid))
        return event_out(c.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone())


@app.delete("/events/{eid}")
def del_event(eid: int, u=Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM events WHERE id=? AND user_id=?", (eid, u["id"]))
    return {"ok": True}


# ───────────────────────── Datos de demostración ─────────────────────────
def seed_data(c, u) -> bool:
    """Carga contactos, recorridos y eventos de ejemplo. Idempotente: no duplica si ya hay recorridos."""
    if c.execute("SELECT 1 FROM trips WHERE user_id=? LIMIT 1", (u["id"],)).fetchone():
        return False
    now, day = time.time(), 86400
    if not contacts_of(c, u["id"]):
        for i, (n, r, p) in enumerate([("María Fernanda Ríos", "Madre o padre", "+57 300 000 0101"),
                                       ("Andrés Gómez", "Hermano/a", "+57 300 000 0102"),
                                       ("Laura Pérez", "Amigo/a", "+57 300 000 0103")], 1):
            c.execute("INSERT INTO contacts(user_id,name,relation,phone,priority) VALUES(?,?,?,?,?)", (u["id"], n, r, p, i))
    base_lat, base_lon = 4.6486, -74.0628
    specs = [(1, 32, 5.8, 1), (2, 48, 9.3, 0), (4, 27, 4.7, 2), (8, 72, 16.4, 0), (12, 35, 6.1, 1), (22, 41, 7.2, 0)]
    for days_ago, mins, dist, n_ev in specs:
        start = now - days_ago * day - 3600
        route = [{"lat": base_lat + 0.0009 * i * (1 if i % 4 < 2 else 0.2),
                  "lon": base_lon + 0.0011 * i * (1 if i % 4 >= 2 else 0.3),
                  "speed": 12 + (i % 5), "t": start + i * 60} for i in range(20)]
        cur = c.execute(
            "INSERT INTO trips(user_id,started,ended,distance_km,duration_s,avg_kmh,max_kmh,route) VALUES(?,?,?,?,?,?,?,?)",
            (u["id"], start, start + mins * 60, dist, mins * 60, round(dist / (mins / 60), 1), 26, json.dumps(route)))
        for k in range(n_ev):
            # Eventos históricos de ejemplo: sin expires_at, por eso el servidor no los escala.
            c.execute(
                "INSERT INTO events(user_id,trip_id,kind,severity,status,ts,place,lat,lon,note,timeline,source) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (u["id"], cur.lastrowid, "impact", "media" if k == 0 else "baja", "preliminar",
                 start + (10 + 5 * k) * 60, "Usaquén (aprox.)", route[8]["lat"], route[8]["lon"],
                 "Detección preliminar sin confirmar", "[]", "helmet"))
    return True


@app.post("/demo/seed")
def seed(u=Depends(current_user)):
    """Carga datos de ejemplo en la cuenta (solo para pruebas)."""
    with db() as c:
        seeded = seed_data(c, u)
    return {"ok": True, "seeded": seeded}


def ensure_demo_user():
    """Cuenta de demostración siempre disponible (útil si el hosting gratuito borra la base de datos)."""
    with db() as c:
        if c.execute("SELECT 1 FROM users WHERE email=?", (DEMO_EMAIL,)).fetchone():
            return
        salt = secrets.token_hex(16)
        try:
            cur = c.execute(
                "INSERT INTO users(email,name,pw_hash,salt,settings,created) VALUES(?,?,?,?,?,?)",
                (DEMO_EMAIL, "Ciclista Demo", hash_pw(DEMO_PASS, salt), salt,
                 json.dumps({**DEFAULT_SETTINGS, "helmet_demo": True}), time.time()))
        except sqlite3.IntegrityError:  # otro worker la creó primero
            return
        seed_data(c, c.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone())
