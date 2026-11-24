# Contrato: rutas HTTP

Aplicación con vistas HTML renderizadas en el servidor. Convenciones comunes:

- Toda entrada (body, query, params) se valida con un esquema zod antes de usarse; un fallo devuelve 400 con
  mensajes por campo, sin detalles internos.
- Rutas con cookie de sesión que cambian estado (`POST`) exigen el token CSRF. `GET` nunca cambia estado.
- Roles: **Pub** = sin sesión · **P** paciente · **M** médico aprobado · **Mp** médico pendiente/rechazado ·
  **R** recepción · **S** soporte (con segundo factor completo).
- Rutas públicas y de autenticación tienen límite de peticiones por IP. Respuestas de error de autenticación son
  uniformes (no revelan si el correo existe, salvo el alta de paciente, aceptado en 0001).
- Códigos: 200 vista, 303 redirección tras `POST`, 400 validación, 401 sin sesión, 403 sin permiso o falta de
  aceptación vigente, 404 recurso inexistente **o no perteneciente al médico** (no se distingue), 429 límite.

## Autenticación y sesión

| Método y ruta | Rol | Entrada (zod) | Resultado |
|---------------|-----|---------------|-----------|
| `GET /login` | Pub | — | Formulario |
| `POST /login` | Pub | `email`, `password` | 303 al panel del rol; si hay MFA, a `/login/mfa`; mismos mensajes ante error; espera creciente tras fallos |
| `GET/POST /login/mfa` | sesión a medias | `code` (TOTP de 6 dígitos o código de recuperación) | Cada código sirve una sola vez (el TOTP no se puede reutilizar dentro de su paso de tiempo); los fallos cuentan para la espera creciente; al acertar se rota el token de la sesión |
| `POST /logout` | cualquiera | — | Revoca la sesión |
| `GET /recuperar` · `POST /recuperar` | Pub | `email` | Siempre la misma pantalla; si existe, encola correo con enlace de 30 min |
| `GET /recuperar/:token` | Pub | `token` | Muestra formulario si es válido; **no consume** |
| `POST /recuperar/:token` | Pub | `password`, `passwordConfirm` | Consume el token, cambia la contraseña, revoca otras sesiones, avisa por correo |
| `GET/POST /cuenta/contrasena` | autenticado | `currentPassword`, `newPassword` | Pide contraseña actual; revoca las demás sesiones; avisa por correo |
| `GET /cuenta/mfa` | M, R, S | — | Estado del doble factor (los pacientes no lo usan: 403) |
| `GET /cuenta/mfa/alta` | M, R, S | — | Misma pantalla; es la **única** a la que soporte llega mientras no active el doble factor (navegador: 303; JSON: 403 `mfa_enrollment_required` en el resto) |
| `POST /cuenta/mfa/activar` | M, R, S | `currentPassword` | Genera el secreto (cifrado, aún inactivo) y muestra clave y URI `otpauth://` |
| `POST /cuenta/mfa/confirmar` | M, R, S | `code` | Con un código correcto activa, rota la sesión ya verificada y muestra los 10 códigos de recuperación **una sola vez** |
| `POST /cuenta/mfa/desactivar` | M, R | `currentPassword` | Borra secreto y códigos; avisa por correo. Soporte no puede (403) |
| `GET/POST /cuenta/correo` | autenticado | `currentPassword`, `newEmail` | Pide el cambio: el correo nuevo queda **pendiente** y se le envía un enlace de confirmación (60 min, un solo uso); el correo de acceso NO cambia todavía. Avisa al correo actual de que se pidió el cambio |
| `GET /cuenta/correo/confirmar/:token` | Pub | `token` | Muestra el correo nuevo y un botón; **no consume** |
| `POST /cuenta/correo/confirmar/:token` | Pub | — | Consume el token, aplica el cambio, avisa al correo anterior y al nuevo y cierra **todas** las sesiones. Si otra cuenta ya usa el correo: 400 genérico |
| `GET/POST /cuenta/movil-emergencia` | M | `currentPassword`, `emergencyMobile` (10 dígitos MX) | Cambio sensible; valida unicidad; el móvil nuevo queda sin verificar hasta la fase con WhatsApp; avisa por correo |

## Médicos

| Método y ruta | Rol | Entrada | Resultado |
|---------------|-----|---------|-----------|
| `GET /medicos/registro` | Pub | — | Formulario con casillas sin marcar |
| `POST /medicos/registro` | Pub | multipart: `fullName`, `email`, `password`, `cedulaNumber`, `cedulaFile` (≤ 5 MB; JPEG/PNG/PDF por firma), `emergencyMobile` (10 dígitos MX), `officePhone?`, `acceptPrivacy`, `acceptTerms` | 303 a `/medicos/estado`; sin ambas casillas, 400. Cédula o móvil duplicados, 400 con mensaje que remite a soporte. Correo ya registrado con otro rol, 400 con mensaje genérico. En producción con aviso provisional: 403 |
| `GET /medicos/estado` | Mp | — | Estado de la solicitud y motivo si fue rechazada |
| `POST /medicos/estado/reenviar` | Mp rechazado | `cedulaNumber?`, `cedulaFile?`, `emergencyMobile?` | Vuelve a `pending` |
| `GET /medicos/inicio` | M, Mp | — | Punto de entrada del rol: 303 a `/medicos/panel` si está aprobado o a `/medicos/estado` si no |
| `GET /medicos/panel` | M | — | Panel mínimo (marcador de las demás features) |

## Pacientes

| Método y ruta | Rol | Entrada | Resultado |
|---------------|-----|---------|-----------|
| `GET /pacientes/registro` | Pub | — | Formulario con casilla de aviso y consentimiento de datos de salud, sin marcar |
| `POST /pacientes/registro` | Pub | `fullName`, `birthDate`, `email`, `phone`, `password`, `acceptPrivacy` | 303 a `/pacientes/panel`. Correo existente: indica iniciar sesión. En producción con aviso provisional: 403 |
| `GET /pacientes/panel` | P | — | Pacientes de la cuenta (propia y adicionales) |
| `POST /pacientes/adicionales` | P | `fullName`, `birthDate`, `phone?`, `acceptPrivacyOnBehalf` | Crea el paciente adicional y su aceptación en nombre del menor |
| `GET /agenda/pacientes/:patientId` | M, R (con médico activo) | `patientId` | Detalle de contacto (nombre, teléfono, correo, edad calculada, tutor si es menor) **solo** si existe `doctor_patient`; si no, 404. Siempre escribe `patient_access_log` (permitido o denegado) |

La reserva y la relación `doctor_patient` automática llegan con la feature 3; aquí la ruta de detalle existe para
cumplir FR-040 y FR-041 con datos de prueba.

## Recepción

| Método y ruta | Rol | Entrada | Resultado |
|---------------|-----|---------|-----------|
| `GET /medicos/recepcion` | M | — | Lista de personas e invitaciones vigentes |
| `POST /medicos/recepcion/invitar` | M | `email` | Rechaza si ya hay 2 (pendientes + activas); encola correo con enlace de 7 días |
| `POST /medicos/recepcion/:membershipId/retirar` | M | `membershipId` | Retira el acceso al instante y revoca sus sesiones con ese médico |
| `POST /medicos/recepcion/invitaciones/:id/revocar` | M | `id` | Revoca una invitación pendiente |
| `GET /recepcion/invitacion/:token` | Pub | `token` | Muestra resumen e invitado; **no consume** |
| `POST /recepcion/invitacion/:token` | Pub | `fullName`, `password?` (solo si es cuenta nueva), `acceptPrivacy`, `acceptConfidentiality` | Consume el token, vincula a la persona con el médico. En producción con aviso provisional: 403 |
| `GET/POST /recepcion/medico-activo` | R | `doctorId` | Elige con qué médico trabaja (solo entre vínculos vigentes) |
| `GET /recepcion/panel` | R | — | Panel mínimo con el médico activo |

Permisos negados a recepción (siempre 403, con prueba): configuración, pagos, móvil de emergencias, cédula, invitar.

## Documentos legales

| Método y ruta | Rol | Entrada | Resultado |
|---------------|-----|---------|-----------|
| `GET /legal` | Pub | — | Índice de documentos vigentes |
| `GET /legal/:type` · `GET /legal/:type/v/:version` | Pub | `type` en lista cerrada, `version` entero | Texto vigente o histórico |
| `GET /legal/aceptar` · `POST /legal/aceptar` | autenticado | una casilla `accept_<id>` por documento pendiente | Pantalla que bloquea el uso hasta aceptar las versiones vigentes (FR-021); escribe `consent_acceptance` |
| (pie) | todas las páginas públicas | — | Enlace al aviso de privacidad (FR-022) |
| `GET /derechos` | Pub | — | Canal y plazo para ejercer derechos ARCO (FR-024), leídos de `RIGHTS_CONTACT_EMAIL` y `RIGHTS_RESPONSE_DAYS` |

Cualquier ruta autenticada responde 403 con redirección a `/legal/aceptar` si falta la aceptación de una versión vigente.

## Soporte (vista mínima)

| Método y ruta | Rol | Entrada | Resultado |
|---------------|-----|---------|-----------|
| `GET /soporte/medicos` | S | `status?` | Lista de solicitudes |
| `GET /soporte/medicos/:id` | S | `id` | Datos y enlace a la cédula |
| `GET /soporte/medicos/:id/cedula` | S | `id` | Entrega el archivo tras comprobar rol y MFA; cabeceras `Content-Disposition` y `nosniff` |
| `POST /soporte/medicos/:id/aprobar` | S | — | `approved`, inicia prueba de 5 días, correo al médico, registra decisión |
| `POST /soporte/medicos/:id/rechazar` | S | `reason` (obligatorio) | `rejected`, correo al médico, registra decisión |
| `POST /soporte/medicos/:id/liberar-cedula` | S | `reason` | Pone `NULL` en cédula y móvil, registra la decisión |

## Ejecución programada (no es una ruta)

- `npm run jobs:outbox`: procesa `email_outbox` con reintentos (cron cada minuto; idempotente).
- `npm run jobs:cleanup`: borra tokens vencidos, sesiones vencidas y correos entregados antiguos.
- `npm run support:create`: crea una cuenta de soporte (pide la contraseña por entrada estándar).

> Feature 5: las rutas de médico y recepción rechazan una cuenta suspendida (403) y las escrituras de una cuenta en solo lectura; ver `specs/005-panel-de-soporte/contracts/http-routes.md`. La vista mínima de soporte (FR-007) quedó ampliada en el panel de la feature 5 y el supuesto abierto 10 (liberar una cédula en disputa) quedó resuelto allí.
