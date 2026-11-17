# SafeRide

App móvil (Expo Go) + servidor en Python con login. Los datos (cuentas, contactos, recorridos, alertas) viven en el servidor, así que funcionan desde cualquier teléfono.

```
saferide/
├─ backend/   Python · FastAPI + SQLite + JWT   (API con login)
└─ app/       Expo (React Native)               (15 pantallas, Expo SDK 57)
```
> Expo Go solo ejecuta JavaScript, por eso la app es Expo/React Native y la lógica en Python es el servidor.

## 1. Servidor Python (en tu computador)
```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt "pydantic[email]"
uvicorn main:app --host 0.0.0.0 --port 8000
```
Prueba rápida: `python smoke_test.py` → "OK". Documentación interactiva: http://localhost:8000/docs

## 2. App con Expo Go
Requiere Node 18+ y la app **Expo Go** en el teléfono (misma red Wi‑Fi que el computador).
```bash
cd app
npm install
npx expo start
```
Escanea el QR con Expo Go. La app detecta sola la IP del computador y usa `http://<IP>:8000`.
Si no conecta, en la pantalla de login toca **⚙ Servidor** y escribe la IP (ej. `http://192.168.1.10:8000`).
Si tu red bloquea la conexión: `npx expo start --tunnel` (para el servidor usa ngrok o permite el puerto 8000 en el firewall).

## 3. Usarla
1. **Regístrate** (nombre, correo, contraseña) e inicia sesión; la sesión se mantiene.
2. En **Perfil → Cargar datos de demostración** para ver historial, alertas y contactos de ejemplo.
3. **Iniciar recorrido** usa el GPS real del teléfono (ruta, distancia, velocidad); **Finalizar** lo guarda.
4. **Simular alerta de posible caída** (Inicio): cuenta regresiva de 30 s. «Estoy bien» la descarta; «Confirmar emergencia» o llegar a 0 registra el aviso a tus contactos.
5. Contactos (agregar/editar/eliminar/hacer principal), sensibilidad del casco y permisos se guardan en tu cuenta.

## Alcance del prototipo
- Casco y batería son **simulados** (no hay Bluetooth real); GPS y recorridos son reales.
- El «aviso a contactos» se registra en el servidor; no envía SMS ni llama a emergencias.
- Producción: define `SAFERIDE_SECRET` (clave JWT) y sirve la API por HTTPS.
