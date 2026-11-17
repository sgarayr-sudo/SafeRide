# Integrar la alerta de choque y el casco en la app

Estos archivos **no incluyen** tu carpeta `app/` (no venía en el zip). Copia y conecta así:

## 1. Dependencias
```bash
cd app
npx expo install expo-dev-client react-native-ble-plx expo-audio expo-keep-awake
```

## 2. Permisos (app.json)
```json
{
  "expo": {
    "plugins": [
      ["react-native-ble-plx", {
        "isBackgroundEnabled": true,
        "modes": ["central"],
        "bluetoothAlwaysPermission": "SafeRide usa Bluetooth para conectarse a tu casco."
      }]
    ]
  }
}
```

## 3. Copiar archivos
```
app-integracion/src/crash/   →  app/src/crash/
app-integracion/assets/alarm.wav  →  app/assets/alarm.wav
```
(Si tu app no usa `src/`, ajusta la ruta `../../assets/alarm.wav` dentro de `CrashAlertProvider.tsx`.)

## 4. Envolver la app
En el componente raíz (`App.tsx` o `app/_layout.tsx`), dentro de tu proveedor de sesión:
```tsx
import { CrashAlertProvider, makeCrashApi } from "./src/crash";

const crashApi = makeCrashApi(API_URL, () => session.token);   // tu URL y tu token JWT

<CrashAlertProvider
  api={crashApi}
  settings={{ phoneSound: user.settings.phone_sound }}
  bluetoothEnabled={user.settings.bluetooth}
  tripId={currentTripId}
  getLocation={async () => /* tu GPS actual → { lat, lon } o null */ null}
>
  {/* tu app */}
</CrashAlertProvider>
```

## 5. Conectar los botones existentes
```tsx
import { useCrashAlert } from "./src/crash";
const { triggerSimulated, helmetState, batteryPercent, testHelmetBuzzer } = useCrashAlert();

<Button title="Simular alerta de posible caída" onPress={triggerSimulated} />
// helmetState: "connected" | "scanning" | ... → úsalo en la tarjeta del casco (reemplaza el valor simulado)
// batteryPercent: batería real del casco, o null si no la expone
```

## 6. Construir y probar
```bash
eas build --profile development --platform android   # instala el APK de desarrollo en el teléfono
npx expo start --dev-client
```
- Sin el development build (Expo Go), la app funciona igual pero `helmetState` queda en `"unavailable"`.
- Prueba sin hardware: usa «Simular alerta» o un teléfono/PC con una app de simulación BLE (p. ej. nRF Connect)
  que anuncie el servicio de `docs/BLE_PROTOCOLO.md` y envíe el paquete de 8 bytes.

## Qué falta verificar tú
- Que el código compile y se vea bien dentro de tu app (solo se comprobaron los tipos de TypeScript por separado).
- La conexión real con el casco: no se probó con hardware.
- BLE en segundo plano en iOS/Android (reglas nativas distintas); el buzzer del casco y el servidor funcionan igual.
