# Publicar SafeRide

## A. Servidor en Render (gratis) — ya hecho si `https://TU-SERVICIO.onrender.com/health` responde `{"ok":true,...}`
1. Sube el repositorio a GitHub.
2. render.com → **New → Blueprint** → elige el repositorio (usa `render.yaml`) → **Apply** → espera **Live**.
3. `SAFERIDE_SECRET` la genera Render sola. No la subas a GitHub.
4. Plan gratis: el servidor se duerme tras 15 min sin uso (la primera petición tarda 30–50 s), **la base de datos
   se borra al reiniciar** (los usuarios registrados desaparecen; la cuenta `demo@saferide.app` / `demo1234` se recrea)
   y, dormido, no escala alertas vencidas.

## B. APK de Android (para instalar en cualquier teléfono)

### Una sola vez: preparar el computador
1. Instala **Node.js (versión LTS)** desde https://nodejs.org (siguiente, siguiente, finalizar). Reinicia el computador.
2. Crea una cuenta gratis en https://expo.dev (solo correo y contraseña).

### Poner la dirección de tu servidor
Abre `app/app.json` con el Bloc de notas y cambia `PON_AQUI_LA_URL_DE_RENDER` por tu dirección de Render, por ejemplo
`https://saferide-api-xxxx.onrender.com` (con `https://`, sin `/` al final). Guarda.
*(Si no lo haces, cada persona tendrá que escribir la dirección al abrir la app la primera vez.)*

### Generar el APK
1. Abre la carpeta `SafeRide/app`. Haz clic en la barra de direcciones de la ventana, escribe `cmd` y pulsa **Enter**
   (se abre una ventana negra ya ubicada en esa carpeta).
2. Escribe estos comandos, **uno por uno**, pulsando Enter y esperando a que termine cada uno:
```
npm install
npm install -g eas-cli
eas login
eas init
eas build -p android --profile preview
```
   - `eas login`: escribe el correo y la contraseña de expo.dev.
   - `eas init`: si pregunta por crear el proyecto, responde **Y** y Enter.
   - `eas build`: si pregunta *"Generate a new Android Keystore?"* responde **Y** y Enter.
3. El proceso corre en la nube y tarda de 10 a 20 minutos. Al terminar muestra un **enlace y un código QR** para
   descargar el archivo `.apk`. También lo encuentras en https://expo.dev → tu proyecto → **Builds**.

### Instalarlo
Abre el enlace desde el teléfono Android, descarga el `.apk` y ábrelo. Android pedirá permitir "instalar apps de
orígenes desconocidos" para el navegador: acéptalo. Puedes compartir el mismo enlace o el archivo con otras personas.

### Si algo falla
- `npm` o `eas` "no se reconoce": cierra la ventana negra, ábrela de nuevo (o reinicia) tras instalar Node.js.
- El build falla: abre el enlace de logs que muestra y copia las últimas líneas.
- La app abre pero no entra: revisa la dirección del servidor en la pantalla de acceso («Cambiar servidor») y abre
  `…/health` en el navegador para despertar el servidor.
