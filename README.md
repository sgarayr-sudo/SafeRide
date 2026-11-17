# SafeRide

Casco inteligente para ciclistas + app móvil. Cuando el casco detecta un choque, **suena su alarma y la app
muestra una alerta a pantalla completa** con sirena, vibración y cuenta regresiva de 30 s. Si el ciclista no
responde, el aviso a sus contactos se registra (y el servidor lo escala solo si el teléfono no responde).

```
SafeRide/
├─ backend/          Python · FastAPI + SQLite + JWT   (API, pruebas)
├─ app/              Expo (React Native)               (15 pantallas)   ← tu carpeta actual de la app
├─ app-integracion/  Alerta de choque + Bluetooth del casco, lista para copiar dentro de app/
└─ docs/BLE_PROTOCOLO.md   Contrato de datos casco ↔ app (para el firmware)
```

## 1. Servidor (en tu computador)
```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```
Documentación interactiva: http://localhost:8000/docs · Pruebas: `pip install -r requirements-dev.txt && pytest -q`

Variables de entorno (ver `backend/main.py`): `SAFERIDE_SECRET` (**obligatoria en producción**; en local se genera
una y se guarda en `backend/.saferide_secret`), `SAFERIDE_DB`, `SAFERIDE_DEMO`, `SAFERIDE_CORS`.

En Windows puedes usar `INICIAR.bat`, que prepara todo y abre servidor y app.

## 2. App
Requiere Node 18+. Sin Bluetooth real funciona con **Expo Go**:
```bash
cd app && npm install && npx expo start
```
Para conectar el **casco por Bluetooth** hace falta un *development build* (Expo Go no incluye módulos nativos
como `react-native-ble-plx`). Pasos en [`app-integracion/INTEGRACION.md`](app-integracion/INTEGRACION.md).

## 3. Cómo funciona la alerta de choque
1. El casco detecta el impacto, **activa su buzzer** y avisa a la app por BLE (`docs/BLE_PROTOCOLO.md`).
2. La app abre la pantalla de alerta (sirena, vibración, 30 s) y registra el evento: `POST /events`.
3. El ciclista elige:
   - **Estoy bien** → silencia el casco y descarta la alerta (`/events/{id}/resolve` → `descartada`).
   - **Pedir ayuda ahora**, o la cuenta llega a 0 → se registra el aviso a los contactos (`notificada`).
4. Si el teléfono está apagado o sin señal, **el servidor escala la alerta** al vencer `expires_at` + 5 s.
5. Al abrir la app, `GET /events/active` retoma una cuenta regresiva que siga en curso.

Sin casco, el botón **Simular alerta de posible caída** (Inicio) usa el mismo flujo con `source: "phone"`.

### Endpoints de alertas
| Método | Ruta | Uso |
|---|---|---|
| POST | `/events` | Crea la alerta (`kind` impact/fall, `source` helmet/phone/manual, `client_id`, `peak_g`, `countdown_s`). Repetir el mismo `client_id` devuelve el mismo evento. |
| GET | `/events/active` | Alertas pendientes del usuario (y hora del servidor). |
| POST | `/events/{id}/resolve` | `descartada` o `notificada`. Idempotente; cambiar una alerta ya resuelta da 409. |
| GET | `/events`, `/events/{id}` | Historial y detalle (con línea de tiempo y contactos avisados). |

## 4. Usarla
1. **Regístrate** o entra con la cuenta de prueba `demo@saferide.app` / `demo1234`.
2. En **Perfil → Cargar datos de demostración** verás historial, alertas y contactos de ejemplo.
3. **Iniciar recorrido** usa el GPS real; **Finalizar** lo guarda.
4. Contactos, sensibilidad del casco y permisos se guardan en tu cuenta.

## Alcance del prototipo
- El «aviso a contactos» **se registra en el servidor; no envía SMS, WhatsApp ni llama a emergencias.** La línea de
  tiempo lo indica así. Falta integrar un proveedor (Twilio, WhatsApp Business, push) para enviarlo de verdad.
- El protocolo BLE es una propuesta pendiente de validar con el firmware y el hardware reales.
- Con la app cerrada o el teléfono bloqueado, la conexión BLE exige configuración nativa adicional.
- Cuenta demo con contraseña pública: desactívala en producción con `SAFERIDE_DEMO=0`.
