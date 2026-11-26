# Contrato: rutas HTTP del micrositio y de las citas del paciente

Mismas convenciones que [la feature 1](../../001-cuentas-y-acceso/contracts/http-routes.md) y
[la feature 2](../../002-calendario-del-medico/contracts/http-routes.md): entrada validada con zod (400 con mensajes por
campo), `POST` con CSRF, `GET` nunca cambia estado, 303 tras `POST`, 404 para recursos inexistentes **o ajenos**, 429
por límite. Roles: **Pub** sin sesión · **P** paciente · **M** médico aprobado · **R** recepción. `:slug` es el nombre del
enlace; el médico de cada operación pública **sale del `slug` resuelto en el servidor**, nunca de un campo del cliente.
Todas las rutas HTML llevan `noindex` (meta y cabecera `X-Robots-Tag`).

## Micrositio público y entrada del paciente

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /c/:slug` | Pub | `slug` válido | Micrositio (nombre, dirección con enlace «Cómo llegar» —JSON: `directionsUrl`, o `null` sin dirección—, teléfono, logo, «Primera cita» / «Ya soy paciente», pie con aviso de privacidad); con sesión de paciente, 303 a `/c/:slug/reservar`; nunca publicado: **404**; despublicado o médico no aprobado: aviso con nombre y teléfono, sin calendario |
| `GET /c/:slug/logo` | Pub | `slug` | Imagen del logo (tipo fijo por firma, `nosniff`, caché corta); 404 si no hay logo o el micrositio no está publicado |
| `GET /c/:slug/entrar` · `POST /c/:slug/entrar` | Pub | `email`, `password` | «Ya soy paciente». Éxito: sesión y 303 a `/c/:slug/reservar`. Contraseña incorrecta: 401 `invalid_credentials` con espera creciente. Sin cuenta de paciente con ese correo (también si es de otro rol): 401 `no_account` con la opción «Primera cita». Límite 10/min por IP |
| `GET /c/:slug/primera-cita` · `POST /c/:slug/primera-cita` | Pub | `fullName`, `birthDate`, `email`, `phone`, `password`, `acceptPrivacy` (casilla) | Crea cuenta y paciente (feature 1), registra la aceptación, inicia sesión y 303 a `/c/:slug/reservar`; correo ya registrado: mensaje con enlace a «Ya soy paciente»; sin la casilla: 400. Límite 10/min por IP |

## Reserva del paciente

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /c/:slug/reservar` | P | query `mes?` (`AAAA-MM`), `fecha?` (`AAAA-MM-DD`) | Calendario del mes (días con horarios libres habilitados; sin pasados ni más allá de la anticipación máxima) y, con `fecha`, la lista de horarios libres que cumplen la anticipación mínima. Sin sesión: 303 a `/c/:slug`. Micrositio no publicado: aviso con teléfono |
| `GET /c/:slug/paciente-adicional` · `POST /c/:slug/paciente-adicional` | P | los de añadir paciente adicional (feature 1) | Añade un paciente adicional bajo la cuenta y regresa a `/c/:slug/reservar` |
| `POST /c/:slug/reservar` | P | `inicio` (`AAAA-MM-DDTHH:MM` local), `patientId` (de la cuenta), `autorizo` (casilla; obligatoria si no hay autorización activa con este consultorio) | En la transacción con bloqueo: valida horario, anticipaciones, no solape, pertenencia del paciente, límites y autorización; crea o reactiva el vínculo; inserta la cita; encola los correos; registra. 303 a `/pacientes/citas/:id`. 409 `slot_unavailable` si ya no está libre; 400 si el horario no existe o falta la casilla; 403 si el micrositio dejó de aceptar reservas; 404 si el paciente no es de la cuenta; 429 con `Retry-After` por límites. Doble envío: si la cita vigente de ese horario ya es de la misma cuenta, 303 a esa cita. Límite 20/hora por IP |

## Mis citas y cancelación (paciente)

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /pacientes/citas` | P | — | Próximas citas y las de los últimos 90 días de las personas de la cuenta, con consultorio, fecha, hora y estado |
| `GET /pacientes/citas/:id` | P | `id` | Resumen y, si es cancelable, el botón; 404 si la cita no es de una persona de la cuenta |
| `POST /pacientes/citas/:id/cancelar` | P | `id` | Cancela si es vigente y falta al menos el límite del consultorio (inclusive); libera el horario, avisa al médico y envía constancia al paciente; 303 a `/pacientes/citas`. Dentro del límite: 409 `cancellation_window_closed` con el teléfono del consultorio; ya cancelada o pasada: 409; ajena: 404; 429 por límite (10/hora por cuenta, 30/hora por IP) |

## Enlaces de correo

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /citas/enlace/:token` | Pub / P | `token` (43 caracteres) | Token válido **sin consumirlo**: sin sesión, pantalla de inicio de sesión del paciente; con la sesión de la cuenta dueña de la cita, resumen y botón; cualquier otro caso (vencido, usado, cita cancelada o pasada, otra cuenta): mensaje genérico 410 sin datos de la cita. Límite 60/min por IP |
| `POST /citas/enlace/:token/entrar` | Pub | `email`, `password` | Inicia sesión y 303 al mismo enlace; mismas respuestas y límites que «Ya soy paciente» |
| `POST /citas/enlace/:token/cancelar` | P | `token` | Igual que `POST /pacientes/citas/:id/cancelar` y además **consume** el token; una segunda vez: 410 |

## Mis consultorios (paciente)

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /pacientes/consultorios` | P | — | Consultorios con vínculo activo con alguna persona de la cuenta: nombre, origen («Lo creaste tú» / «Lo creó el consultorio») y fecha |
| `GET /pacientes/consultorios/:doctorId/revocar` | P | `doctorId` | Pantalla de confirmación: cuántas citas futuras se cancelarán y qué deja de ver el consultorio; 404 si no hay vínculo activo |
| `POST /pacientes/consultorios/:doctorId/revocar` | P | `doctorId` | En la transacción con bloqueo del médico: cancela las citas futuras de la cuenta con ese consultorio, avisa al médico por cada una, retira el acceso al contacto y registra; 303 a `/pacientes/consultorios` |

## Micrositio (médico)

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /medicos/micrositio` | M | — | Estado, enlace, nombre (si ya lo eligió), dirección, logo y pasos que faltan para publicar |
| `POST /medicos/micrositio/nombre` | M | `slug` (3–40, `^[a-z0-9]+(-[a-z0-9]+)*$`) | Reserva el nombre una sola vez; en uso: 409 `slug_taken`; ya tenía nombre: 409 (solo soporte lo cambia) |
| `POST /medicos/micrositio` | M | `address` (≤ 300) | Guarda la dirección |
| `POST /medicos/micrositio/logo` | M | archivo `logo` (PNG, JPEG o WebP ≤ 1 MB, validado por contenido) | Guarda y reemplaza el logo; inválido: 400 sin guardar |
| `POST /medicos/micrositio/logo/quitar` | M | — | Borra el logo |
| `POST /medicos/micrositio/publicar` | M | — | Publica si hay nombre, dirección, teléfono del consultorio y al menos una franja; si no, 409 con la lista de lo que falta |
| `POST /medicos/micrositio/despublicar` | M | — | Despublica; las citas existentes se conservan |
| `GET /agenda/configuracion` · `POST /agenda/configuracion` (feature 2) | M | + `cancelNoticeHours` (0–168, por defecto 24) | El límite de cancelación del paciente se configura aquí |

Recepción, médicos pendientes o rechazados, pacientes y soporte reciben 403 en las rutas del médico; un médico o recepción
con sesión que abre `/c/:slug/reservar` o `/pacientes/…` recibe 403.

## Negociación y errores

- Aceptan `Accept: application/json` como en las features 1 y 2 (útil para pruebas).
- Los mensajes de error no revelan detalles internos ni datos de otras cuentas; los enlaces de correo inválidos responden
  siempre igual (410).
- Registros técnicos: solo identificadores (médico, cita, cuenta), nunca nombres, correos ni teléfonos.

## Pruebas de contrato mínimas

Cada ruta: sin sesión (401 o redirección a la entrada del micrositio), rol no permitido (403), ajena (404), sin CSRF en
`POST` (403), validación (400). Además: micrositio nunca publicado (404 idéntico a ruta inexistente), despublicado (aviso
con teléfono), reserva con micrositio despublicado (403), 409 por horario ocupado, 429 por límites, enlace abierto 100 veces
sin cambios, enlace de otra cuenta (410 genérico).

> Feature 5: soporte cambia el nombre del enlace desde el panel (`/soporte/micrositios/:doctorId/enlace`); el nombre anterior queda reservado 90 días para su dueño y un micrositio de un médico suspendido o en solo lectura no acepta reservas.
