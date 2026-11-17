# Protocolo BLE casco ↔ app

Contrato entre el firmware del casco (periférico BLE, p. ej. ESP32) y la app (central).
La app ya lo implementa en `app-integracion/src/crash/protocol.ts`; el firmware debe respetar estos valores.

> Estado: **propuesta sin probar con hardware real.** Si el casco usa otro módulo o ya tiene un
> protocolo propio, ajusta `protocol.ts` y este documento a lo que exista.

## Servicios y características

| Elemento | UUID | Propiedades |
|---|---|---|
| Servicio SafeRide | `7d5a1000-3c1e-4b7a-9d2f-5a1e51de0001` | (el casco lo anuncia en la publicidad BLE) |
| Choque (`CRASH`) | `7d5a1001-3c1e-4b7a-9d2f-5a1e51de0001` | Read, Notify |
| Control (`CONTROL`) | `7d5a1002-3c1e-4b7a-9d2f-5a1e51de0001` | Write (con respuesta) |
| Batería | servicio estándar `0x180F`, característica `0x2A19` | Read, Notify (0–100 %) |

## Característica CRASH (casco → app), 8 bytes, little-endian

| Byte | Campo | Valores |
|---|---|---|
| 0 | versión | `1` |
| 1 | tipo | `0` inactivo · `1` impacto · `2` caída · `3` cancelada con el botón del casco |
| 2–3 | fuerza pico | `uint16`, décimas de g (`425` = 42,5 g) |
| 4–5 | `boot_id` | `uint16` aleatorio generado en cada arranque del casco |
| 6–7 | `seq` | `uint16`, contador de choques desde el arranque |

Reglas para el firmware:
1. Al detectar un choque, **suena el buzzer del casco de inmediato**, sin esperar a la app.
2. Mientras la alerta esté activa, el casco **vuelve a notificar cada ~2 s** el mismo `(boot_id, seq)`.
   BLE puede perder paquetes; la app y el servidor eliminan duplicados con ese par.
3. Un `Read` de `CRASH` devuelve el choque activo, o tipo `0` si no hay ninguno. La app lo lee al
   conectarse, así una alerta no se pierde si el teléfono se reconecta tarde.
4. Si el ciclista pulsa el botón del casco, se notifica tipo `3` con el mismo `(boot_id, seq)` y se silencia el buzzer.
5. Si ya hubo un choque con otro `seq`, el nuevo debe incrementar `seq`.

La app construye el identificador del evento como `"<id-del-dispositivo>:<boot_id>:<seq>"` y lo envía como
`client_id`; el servidor devuelve el mismo evento si se repite.

## Característica CONTROL (app → casco)

| Bytes | Comando |
|---|---|
| `01` | Silenciar el buzzer (el ciclista tocó «Estoy bien») |
| `02` | Hacer sonar el buzzer (emergencia confirmada) |
| `03` | Prueba: un pitido corto |
| `10 nn` | Fijar sensibilidad: `nn` = 0 baja, 1 media, 2 alta (equivale al ajuste `sensitivity`) |

## Secuencia de un choque

```
casco: detecta impacto ──► buzzer ON ──► notifica CRASH (tipo 1) cada 2 s
app:   recibe CRASH ──► sirena + vibración + pantalla completa (cuenta regresiva 30 s)
app:   POST /events {kind: impact, source: helmet, client_id, peak_g, countdown_s: 30}
        ├─ «Estoy bien»        → CONTROL 01 → POST /events/{id}/resolve {descartada}
        ├─ «Pedir ayuda ahora» → CONTROL 02 → POST /events/{id}/resolve {notificada, user_confirmed}
        ├─ botón del casco     → CRASH tipo 3 → la app cierra la alerta como «Estoy bien»
        └─ sin respuesta (0 s) → POST /events/{id}/resolve {notificada, timeout}
servidor: si la app no responde (teléfono apagado, sin señal), escala sola al vencer
          expires_at + 5 s (aviso registrado a los contactos).
```

## Limitaciones conocidas
- El «aviso a contactos» **solo se registra** en el servidor; falta integrar SMS/WhatsApp/push para enviarlo de verdad.
- Con la app cerrada o el teléfono bloqueado, BLE en segundo plano exige configuración nativa adicional
  (ver `app-integracion/INTEGRACION.md`). El buzzer del casco y la escalada del servidor funcionan igual.
