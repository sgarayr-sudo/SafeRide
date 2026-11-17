# Publicar SafeRide (para que funcione sin tu computador)

## A. Servidor en Render (gratis)
1. Sube **todo el repositorio** a GitHub (no subas `node_modules`; el `.gitignore` ya lo evita).
2. En render.com: New → **Blueprint** → elige tu repositorio (detecta `render.yaml`, que apunta a `backend/`) → Apply.
3. Espera a que diga **Live**. Tu URL será algo como `https://saferide-api-xxxx.onrender.com`. Prueba `…/health`.
   - `SAFERIDE_SECRET` se genera sola en Render; no la compartas ni la subas al repositorio.
   - Plan gratis: el servicio se "duerme" tras 15 min sin uso (la primera petición tarda ~30–50 s) y **la base de
     datos se borra** al reiniciar. Dormido, **tampoco escala alertas vencidas**: para una demo de choque
     despiértalo antes abriendo `/health`, o usa un plan de pago con disco persistente.
   - La cuenta de demostración **demo@saferide.app / demo1234** se recrea sola. Desactívala con `SAFERIDE_DEMO=0`.

## B. App Android instalable (APK) con EAS
1. Crea cuenta gratis en expo.dev.
2. En `app/`, edita `app.json` y pon tu URL: `"extra": { "apiUrl": "https://saferide-api-xxxx.onrender.com" }`
3. Ejecuta:
```
npm install -g eas-cli
eas login
eas init
eas build -p android --profile preview
```
4. Al terminar (10–20 min) te da un enlace/QR para descargar el **APK**. Para el casco por Bluetooth el APK debe
   incluir `react-native-ble-plx` (ver `app-integracion/INTEGRACION.md`).

## C. (Alternativa) Solo con Expo Go — sin Bluetooth
`npx expo install expo-updates`, `eas update:configure`, `eas update --branch main --message "demo"`; en expo.dev
abre el proyecto → "Open in Expo Go". El teléfono necesita la versión de Expo Go que corresponda a tu SDK.
