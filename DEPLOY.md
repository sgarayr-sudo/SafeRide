# Publicar SafeRide (para que funcione sin tu computador)

## A. Servidor en Render (gratis)
1. Sube la carpeta `saferide` a un repositorio de GitHub (github.com → New repository → "uploading an existing file", arrastra el contenido; no subas `node_modules`).
2. En render.com: New → **Blueprint** → elige tu repositorio (detecta `render.yaml`) → Apply.
3. Espera a que diga **Live**. Tu URL será algo como `https://saferide-api-xxxx.onrender.com`. Prueba `…/health`.
   - Plan gratis: se "duerme" tras 15 min sin uso (la primera petición tarda ~30–50 s) y **la base de datos se borra** al reiniciar.
   - Por eso siempre existe la cuenta de demostración: **demo@saferide.app / demo1234** (con datos de ejemplo).
   - Antes de la presentación, abre la URL `/health` para despertarlo.

## B. App Android instalable (APK) con EAS
1. Crea cuenta gratis en expo.dev.
2. En `saferide/app`, edita `app.json` y pon tu URL: `"extra": { "apiUrl": "https://saferide-api-xxxx.onrender.com" }`
3. Ejecuta:
```
npm install -g eas-cli
eas login
eas init
eas build -p android --profile preview
```
4. Al terminar (10–20 min) te da un enlace/QR para descargar el **APK**. Se instala en cualquier Android (permite "instalar apps desconocidas").

## C. (Alternativa) Solo con Expo Go
`npx expo install expo-updates`, `eas update:configure`, `eas update --branch main --message "demo"`; en expo.dev abre el proyecto → "Open in Expo Go". El teléfono necesita Expo Go 57.
