# Contrato: rutas HTTP de la agenda

Mismas convenciones que [la feature 1](../../001-cuentas-y-acceso/contracts/http-routes.md): entrada validada con zod
(400 con mensajes por campo), `POST` con CSRF, `GET` nunca cambia estado, 303 tras `POST`, 404 para recursos
inexistentes **o de otro médico**, 429 por límite. Roles: **M** médico aprobado · **R** recepción con vínculo vigente
con su médico activo (revalidado en cada petición). Cualquier otro rol (paciente, soporte, médico pendiente o
rechazado) recibe 403, y sin sesión 401. Todas las rutas obtienen el médico del `TenantContext`, **nunca** de un
parámetro de la petición.

Fechas en la URL: `AAAA-MM-DD`, fecha local del consultorio (zona del médico). Horas de formularios: `HH:MM` local.
Un instante se identifica con `inicio` = `AAAA-MM-DDTHH:MM` local (no UTC).

## Agenda

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /agenda` | M, R | — | 303 a `/agenda/dia/<hoy local>` |
| `GET /agenda/dia/:fecha` | M, R | `fecha` válida, hasta 730 días adelante y hasta 365 atrás | Espacios del día con estado, citas (nombre del paciente) y bloqueos; marca citas fuera del horario actual; enlaces a día anterior/siguiente y a la semana |
| `GET /agenda/semana/:fecha` | M, R | igual | Siete días (lunes a domingo de la semana de `fecha`) con lo mismo; enlaces a semana anterior/siguiente |

## Configuración

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /agenda/configuracion` | M | query opcional `guardado=1` | Formulario con valores vigentes o por defecto (7 días × 4 franjas); 403 a recepción. JSON: `{ isDefault, settings: { slotMinutes, gapMinutes, timezone, minNoticeHours, maxAdvanceDays, cancelNoticeHours }, hours: [{ weekday, start, end }] }` |
| `POST /agenda/configuracion` | M | `slotMinutes` (15–180, múltiplo de 5), `gapMinutes` (0–60, múltiplo de 5), `timezone` (lista cerrada), `cancelNoticeHours` (0–168, entero; 24 si no se envía; límite de cancelación del paciente, feature 3), `minNoticeHours` y `maxAdvanceDays` (mínima 0 h–7 d, máxima 1–365 d, mínima < máxima), hasta 4 franjas por día en campos planos `h<día 1-7>_<franja 0-3>_start` y `_end` (`HH:MM` múltiplos de 5; `24:00` solo como fin; ambos vacíos = sin franja), fin > inicio, sin solapes; los errores de una franja usan la clave `h<día>_<franja>` | Reemplaza configuración y franjas en una transacción y registra `settings_updated`; 303 a `/agenda/configuracion`; errores por campo sin guardar nada (en HTML se repinta el formulario con lo escrito). Las citas y los bloqueos existentes no cambian. 303 a `/agenda/configuracion?guardado=1` |

## Citas

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /agenda/citas/nueva` | M, R | query `inicio` | Pantalla para elegir paciente (vinculados del médico y búsqueda por correo); 404 si `inicio` no es un espacio libre y futuro ahora mismo; 400 si `inicio` no es `AAAA-MM-DDTHH:MM`. JSON: `{ inicio, timezone, patients: [{ patientId, fullName }] }` |
| `POST /agenda/citas/buscar` | M, R | `inicio`, `email` | Registra `patient_lookup` (resultado `ok` o `rejected`); respeta el límite de 30/hora por persona y 60/hora por médico (429 con `Retry-After`); muestra los nombres de los pacientes de esa cuenta, cada uno con un boleto firmado de 15 min; si no hay cuenta, mensaje uniforme «No encontramos una cuenta con ese correo». JSON: `{ patients: [{ patientId, fullName, ticket }] }` (lista vacía si no hay cuenta); no devuelve teléfono ni fecha de nacimiento |
| `POST /agenda/citas` | M, R | `inicio`, `patientId`, `ticket?` (obligatorio si el paciente aún no está vinculado) | En la transacción con bloqueo: valida espacio, solapes y paciente; vincula médico-paciente si falta; inserta; encola `appointment_created`; registra la acción. 303 al día de la cita. 409 si el espacio ya no está libre (ocupado, bloqueado o pasado); 400 si el espacio no existe en el horario; 404 si el paciente no es alcanzable |
| `GET /agenda/citas/:id` | M, R | `id` | Resumen: fecha, hora, nombre del paciente, quién la creó; botón «Cancelar cita»; enlace al detalle del paciente (ruta auditada de la feature 1); 404 si es de otro médico |
| `POST /agenda/citas/:id/cancelar` | M, R | `id` | En la transacción: `booked` y con fin futuro → `cancelled`, registra quién y cuándo, encola `appointment_cancelled`, registra la acción; 303 a la agenda del día. Ya cancelada o pasada: 409 sin repetir el aviso; ajena: 404 |

## Bloqueos

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /agenda/bloqueos` | M, R | — | Bloqueos vigentes o futuros (rango en hora local, motivo, quién) y formulario para crear |
| `POST /agenda/bloqueos` | M, R | `desdeFecha`, `desdeHora`, `hastaFecha`, `hastaHora` (local; fin > inicio, fin futuro, duración ≤ 366 días), `motivo?` (≤ 200 caracteres, texto sin HTML) | En la transacción con bloqueo: si hay citas vigentes con fin futuro dentro del rango → **409 sin cambiar nada**, con la lista (fecha, hora, nombre del paciente; hasta 50 y el total) y el texto «Cancela estas citas y vuelve a intentar»; registra `block_rejected`. Si no hay → inserta, registra `block_created`, 303 |
| `POST /agenda/bloqueos/:id/eliminar` | M, R | `id` | Borra el bloqueo completo, registra `block_removed`; 303; ajeno: 404 |
| `POST /agenda/bloqueos/espacio` | M, R | `inicio` | Atajo desde la agenda: bloquea un espacio libre (mismo rango que el espacio); mismas reglas y respuestas que `POST /agenda/bloqueos` |

## Negociación y errores

- Las rutas aceptan `Accept: application/json` como en la feature 1 (útil para pruebas y para la feature 3); el 409
  de bloqueo devuelve `{ "error": "appointments_in_range", "appointments": [{ "id", "startLocal", "patientName" }], "total": n }`.
- Los mensajes de error no revelan detalles internos ni datos de otros médicos.
- Registros técnicos: solo identificadores (médico, cita, bloqueo), nunca nombres ni correos.

## Pruebas de contrato mínimas

Cada ruta: sin sesión (401), rol no permitido (403), médico ajeno (404), CSRF faltante en `POST` (403), validación
(400). Además: 409 por espacio ocupado, 409 por bloqueo con citas y recepción revocada (403 en la misma petición).
