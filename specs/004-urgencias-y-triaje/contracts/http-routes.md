# Contrato: rutas HTTP de urgencias y triaje

Mismas convenciones que las features [1](../../001-cuentas-y-acceso/contracts/http-routes.md),
[2](../../002-calendario-del-medico/contracts/http-routes.md) y [3](../../003-micrositio-y-reserva-del-paciente/contracts/http-routes.md):
entrada validada con zod (400 con mensajes por campo), `POST` con CSRF, `GET` nunca cambia estado, 303 tras `POST` con éxito,
404 para recursos inexistentes **o ajenos**, 429 por límite con `Retry-After`. Roles: **P** paciente · **M** médico aprobado ·
**R** recepción. `:slug` es el nombre del enlace; el médico **sale del `slug` resuelto en el servidor**, nunca de un campo
del cliente. Todas las rutas HTML llevan `noindex` (meta y cabecera `X-Robots-Tag`).

## Urgencia del paciente

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /c/:slug/urgencia` | P | `slug` válido | Formulario: pregunta de señales de alarma (dos casillas sin marcar), una de las cinco categorías (radio, sin valor por defecto), para quién (titular o paciente adicional), casilla de autorización de datos si no hay una activa, y el widget del CAPTCHA. Sin sesión: 303 a `/c/:slug`. Personal o soporte: 403. Micrositio no publicado, médico no aprobado o cuenta en solo lectura: pantalla «confirma por teléfono con el consultorio». En producción con contenido provisional, o sin claves del CAPTCHA: pantalla «llama al consultorio» con el teléfono. Límite 120/min por IP |
| `POST /c/:slug/urgencia` | P | `categoria` (`rojo` \| `naranja` \| `amarillo` \| `verde_claro` \| `verde`), `patientId` (de la cuenta), `senales` (cero o más de `dificultad_respirar_tragar`, `hinchazon_ojo`), `autorizo` (casilla; obligatoria si no hay autorización activa), `cf-turnstile-response` (token, máx. 2048) | Orden: (1) validación zod (400); (2) **señales de alarma**: si hay alguna, 200 con la pantalla de emergencia (aviso de hospital y móvil de emergencias del médico, o teléfono del consultorio si no tiene) sin tocar nada ni contar; (3) **CAPTCHA**: «invalid» → 400 `captcha_invalid` (nada se cuenta); «unavailable» → 200 con «no pudimos verificar», móvil de emergencias y teléfono del consultorio; (4) `requestUrgent` bajo `withCalendarLock`. Con espacio: 303 a `/pacientes/citas/:id`. Sin espacio: 200 con «no encontramos espacio», móvil de emergencias y, si el nivel lo exige, aviso de hospital (cuenta para el límite). Errores: 400 si falta la casilla de autorización o el paciente/categoría no son válidos; 403 si el consultorio dejó de aceptar reservas o rol no permitido; 404 si el paciente no es de la cuenta; 409 `urgent_active` si el paciente ya tiene una urgencia vigente; 429 con `Retry-After` por 3 solicitudes en 24 h o por IP. Doble envío (urgencia vigente de la misma cuenta y paciente creada hace menos de 2 minutos): 303 a esa cita. CSRF obligatorio. Límite 10/hora por IP |

El formulario y las pantallas de resultado nunca repiten la categoría elegida en la URL, en una cookie ni en un campo oculto
que sobreviva a la respuesta; los errores de validación no devuelven el valor de `categoria` recibido.

## Cambios a rutas de la feature 3 (cancelación)

| Método y ruta | Cambio |
|---------------|--------|
| `POST /pacientes/citas/:id/cancelar` · `POST /citas/enlace/:token/cancelar` | Si la cita es de urgencia, se cancela **sin el plazo** del consultorio (mientras no haya empezado); el tope de 10 cancelaciones por hora por cuenta sigue. El aviso al médico es el de cancelación del paciente, sin categoría |
| `GET /pacientes/citas/:id` · `GET /pacientes/citas` | La cita de urgencia se muestra con la etiqueta «Urgencia» y su botón de cancelar siempre disponible hasta que empieza |
| `POST /c/:slug/reservar` | Las urgencias no cuentan para las 5 reservas por hora ni para las 3 citas vigentes por paciente |

## Cambios a rutas de la feature 2 (agenda del personal)

| Método y ruta | Rol | Cambio |
|---------------|-----|--------|
| `GET /agenda/configuracion` | M | Además de lo existente: franjas de urgencia (hasta 2 por día) y `urgentMinNoticeMinutes`. JSON: `settings.urgentMinNoticeMinutes` y `hours: [{ weekday, start, end, kind }]` con `kind` `regular` o `urgent`. 403 a recepción |
| `POST /agenda/configuracion` | M | Además de lo existente: `urgentMinNoticeMinutes` (0–1440, entero; 30 si no se envía) y hasta 2 franjas de urgencia por día en campos planos `u<día 1-7>_<franja 0-1>_start` y `_end` (mismas reglas de formato; ambos vacíos = sin franja; sin solape con **ninguna** franja del mismo día; los errores usan la clave `u<día>_<franja>`). Se guardan junto con las convencionales en la misma transacción |
| `GET /agenda/dia/:fecha` · `GET /agenda/semana/:fecha` | M, R | Los espacios de horario de urgencia se marcan «Urgencia»; las citas con `kind = urgent` llevan la etiqueta «Urgencia». La categoría **no** existe en ningún dato de la agenda |
| `GET /agenda/citas/:id` | M, R | Muestra «Tipo: Urgencia» o «Convencional». JSON: `kind` |
| `POST /agenda/citas` | M, R | El personal puede agendar en un espacio de urgencia libre; la cita queda `regular` |
