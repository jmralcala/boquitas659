# Research: Micrositio del médico y reserva del paciente

Fase 0 de `/speckit-plan`. Formato Decision / Rationale / Alternatives. Esta feature no añade dependencias.

## Hallazgos que afectan al diseño

- **La revocación necesita un estado, no un borrado.** Tras revocar, el consultorio debe conservar «el registro de las
  citas pasadas con el nombre del paciente» (spec FR-033), pero la feature 2 obtiene los nombres solo de pacientes con
  fila en `doctor_patient`. **Decisión**: `doctor_patient` gana `revoked_at` y `origin`; las lecturas de contacto
  (`findPatientForDoctor`, `listPatientsForDoctor`, `findTutorForMinor`, el selector de pacientes) exigen
  `revoked_at IS NULL`; solo `listPatientNamesForDoctor` (nombres en agenda e historial) incluye los revocados.
- **El personal no debe poder reactivar un vínculo revocado.** Con el correo exacto de la cuenta, el personal obtiene un
  boleto (feature 2). Si eso reactivara el vínculo, la revocación no serviría. **Decisión**: agendar desde el personal a
  un paciente con vínculo revocado responde 404 (como un paciente inalcanzable); solo el propio paciente reactiva el
  vínculo al volver a reservar, con una nueva autorización.
- **Los tokens de la feature 1 invalidan al crear.** `create()` invalida los tokens vigentes del mismo propósito y
  sujeto; si confirmación y recordatorio compartieran propósito, el recordatorio mataría el enlace de la confirmación.
  **Decisión**: dos propósitos (`appointment_confirmation`, `appointment_reminder`), cada uno con un solo enlace vivo por
  cita; cancelar la cita invalida ambos (los enlaces de una cita cancelada responden genérico).
- **Los correos de la feature 2 no llevaban enlace ni `Reply-To`.** Esta feature los añade a `appointment_created` y
  `appointment_cancelled`; las pruebas de la feature 2 que afirman «sin enlaces» se actualizan (T033 de la 002).

## Decisiones

### 1. Nombre del enlace
- **Decision**: tabla `doctor_site` con `slug` único. El médico lo elige una sola vez (`INSERT`); la unicidad la decide
  el índice único (el segundo que lo intente recibe el error 1062 → «ya está en uso»), sin `SELECT … FOR UPDATE` sobre
  un rango vacío. Formato: `^[a-z0-9]+(-[a-z0-9]+)*$`, 3 a 40 caracteres. El cambio lo hace soporte (procedimiento
  manual documentado, p. ej. `scripts/change-site-slug.ts` con confirmación) hasta que exista el panel completo.
- **Rationale**: es el patrón que ya resolvió las carreras de la feature 1; la expresión regular excluye guiones al
  principio, al final y consecutivos.
- **Alternatives**: validar con `SELECT` previo (carrera); permitir cambios al médico (rompe enlaces compartidos y
  facilita suplantar nombres de otros consultorios).

### 2. Qué responde `/c/<nombre>` según el estado
- **Decision**: `draft` (nunca publicado) → 404 idéntico al de una ruta inexistente; `published` y médico `approved` →
  micrositio; `unpublished` o médico no aprobado → aviso mínimo (nombre del consultorio y teléfono, sin calendario ni
  reserva). La reserva y el calendario revalidan el estado en el servidor en cada petición.
- **Rationale**: no revela que un nombre está tomado antes de publicarse (spec FR-008) y da una salida al paciente cuando
  un consultorio deja de recibir reservas en línea.
- **Alternatives**: 404 siempre al despublicar (el paciente con una cita futura no tendría el teléfono a mano).

### 3. Contexto de paciente separado por tipos
- **Decision**: `TenantActor` gana `{ kind: "patient"; userId }` y se define `StaffContext` (el contexto cuyo actor es
  médico o recepción). Las funciones de la feature 2 que muestran o cambian datos del consultorio (agenda, bloqueos,
  configuración, cancelar como personal, búsqueda de pacientes, nombres, citas del personal) pasan a exigir
  `StaffContext`. Solo `SiteResolver` (slug + sesión de paciente) fabrica el contexto `patient`; las funciones comunes
  (`loadSettings`, solapes, `insertAppointment`, `enqueueEmail`, `logCalendarAction`) siguen aceptando `TenantContext`.
- **Rationale**: la reserva del paciente comparte con la del personal exactamente la parte delicada (bloqueo del
  médico, solape, índice único); el tipo hace imposible por compilación que un paciente llame a la agenda del personal.
- **Alternatives**: contexto de paciente aparte con repositorios propios (dos caminos para la invariante central);
  comprobación `if (ctx.actor.kind === "patient") throw` en cada función (se puede olvidar al añadir funciones).
- **Impacto**: los `ENUM` `appointment.created_by_role`, `appointment.cancelled_by_role` y
  `calendar_action_log.actor_role` ganan `'patient'`; `route-audit.test.ts` acepta `StaffContext` o `TenantContext` como
  primer parámetro.

### 4. Reserva del paciente
- **Decision**: `reserveAsPatient(ctx, deps, input)` en `withCalendarLock`: (1) micrositio publicado y médico aprobado; (2)
  el paciente elegido pertenece a la cuenta; (3) límites (5 reservas por hora por cuenta, 3 citas vigentes por paciente
  con el consultorio) contados desde `appointment`; (4) horario existente en la configuración, anticipaciones con
  `validatePatientBookingWindow`, sin cita ni bloqueo solapados; (5) autorización de datos (casilla la primera vez, o
  si estaba revocada) y vínculo activo; (6) inserta la cita (`created_by_role = 'patient'`), encola confirmación al
  paciente y aviso al médico, registra la acción. Se factoriza de `createAppointment` la validación de horario y solapes
  para que ambos caminos usen el mismo código.
- **Rationale**: una sola transacción cubre todo (principio III); contar límites desde `appointment` evita tablas nuevas.
- **Alternatives**: confirmación en dos pasos (reserva provisional): descartada por la decisión de producto (la cita queda
  agendada al reservar).

### 5. Entrada del paciente
- **Decision**: rutas bajo el propio micrositio (`/c/<nombre>/entrar`, `/c/<nombre>/primera-cita`) que reutilizan el
  servicio de sesión y de registro de la feature 1; solo cuentas con rol `patient` entran (un correo de otro rol se
  trata como inexistente). Tras iniciar sesión o registrarse se redirige a `/c/<nombre>/reservar`, calculado en el
  servidor desde el `slug` (nunca de un parámetro libre). Límite: 10 intentos por minuto por IP con el mecanismo de
  `@fastify/rate-limit` ya usado, más la espera creciente por cuenta e IP de la feature 1.
- **Rationale**: el flujo es el de la feature 1 con otra puerta de entrada; el retorno calculado evita redirecciones
  abiertas.
- **Alternatives**: parámetro `next` firmado (más piezas para el mismo resultado).

### 6. Calendario «tipo aerolínea» sin JavaScript
- **Decision**: `GET /c/<nombre>/reservar?mes=AAAA-MM&fecha=AAAA-MM-DD`: una cuadrícula del mes con los días que tienen al
  menos un horario libre habilitados (calculado con **una** consulta de citas y de bloqueos del mes y
  `listFreeSlots(forPatient: true)`), y, al elegir un día, la lista de horarios. Navegación de mes limitada a
  [hoy, hoy + anticipación máxima]. El horario se envía con `POST` y el servidor lo vuelve a validar.
- **Rationale**: HTML en servidor, sin librerías; una consulta por mes mantiene el costo bajo.
- **Alternatives**: selector de fecha nativo (no marca los días con disponibilidad).

### 7. Autorización de compartir datos
- **Decision**: tabla `data_authorization` de solo anexar (disparadores como `consent_acceptance`): cuenta, paciente,
  consultorio, quién la dio (el usuario), versión del aviso de privacidad vigente y fecha. Se pide la casilla sin marcar
  cuando no existe una autorización activa para esa cuenta y ese consultorio (primera vez, vínculo creado por el
  personal, o tras revocar). «Activa» = existe una autorización posterior a la última revocación (`doctor_patient.revoked_at`).
- **Rationale**: cumple el principio I (casilla sin marcar, registro de quién, qué versión y cuándo) y deja la
  trazabilidad aunque se revoque.
- **Alternatives**: reutilizar `consent_acceptance` (mezcla documentos legales con consentimientos por consultorio y su
  estructura es por documento, no por consultorio).

### 8. Enlaces de correo
- **Decision**: el outbox crea el token al enviar (patrón de la feature 1). `GET /citas/enlace/<token>` valida sin
  consumir, exige sesión de paciente y que la cita sea de la cuenta, y muestra el resumen con el botón;
  `POST /citas/enlace/<token>/cancelar` (CSRF, sesión) consume el token y cancela. Sin sesión: pantalla de inicio de
  sesión del paciente que regresa al mismo enlace. El token de una cita cancelada, pasada o de otra cuenta responde con el
  mismo mensaje genérico. Vigencia del token: 400 días en la base; la vigencia efectiva termina cuando la cita se cancela o llega su hora y se valida al usar el enlace (decisión del 2026-11-23).
- **Rationale**: abrir un enlace nunca cambia el estado (principio III); el sujeto del token es la cita.
- **Alternatives**: token de vigencia exacta hasta la hora de la cita (la plantilla del outbox tiene TTL fijo; la
  validación del estado de la cita es el control real).

### 9. Recordatorios idempotentes dentro del cron del outbox
- **Decision**: `enqueueDueReminders(db, clock)` corre al inicio de `jobs/outbox.ts`. En una transacción marca
  `appointment.reminder_enqueued_at` con `UPDATE … WHERE reminder_enqueued_at IS NULL AND status = 'booked'` por cada cita
  vencida y solo si la actualización afecta una fila encola `appointment_reminder`; así un cron solapado o un reintento
  no duplica. Momento: `inicio − (cancel_hours + 6 h)`; no se envía si la cita se creó después de ese momento ni si el
  inicio ya pasó. La plantilla tiene `shouldSend` (cita aún vigente).
- **Rationale**: un solo cron (`jobs:outbox`) y una sola entrada del hosting; idempotencia por la propia fila.
- **Alternatives**: tarea de cron aparte (otra entrada que configurar y vigilar); calcular el recordatorio al enviar sin
  marca (duplicados con cron solapado).

### 10. `Reply-To` y destinatarios
- **Decision**: `MailMessage` y `RenderedEmail` ganan `replyTo?`. Los correos del consultorio al paciente (confirmación,
  recordatorio, cancelación del consultorio, aviso de vínculo) llevan como `Reply-To` el correo de la cuenta del médico;
  el aviso al médico va al correo de su cuenta (no a recepción) sin `Reply-To`.
- **Rationale**: decisión 0001 («todo sale de la plataforma, con el médico como `Reply-To`»).
- **Alternatives**: SMTP propio de cada médico (fuera de alcance por decisión de producto).

### 11. Logo y ubicación
- **Decision**: logo PNG, JPEG o WebP de hasta 1 MB, tipo decidido por firma de bytes, nombre aleatorio, guardado en
  `LOGO_STORAGE_DIR` (por defecto `<CEDULA_STORAGE_DIR>/logos`, fuera de la raíz pública) y servido por
  `GET /c/<nombre>/logo` con `Content-Type` fijo, `X-Content-Type-Options: nosniff` y caché corta; solo si el
  micrositio está publicado. SVG queda excluido (puede llevar scripts). La ubicación es la dirección en texto más un enlace
  «Cómo llegar» a `https://www.google.com/maps/search/?api=1&query=<dirección codificada>` (`target="_blank"`,
  `rel="noopener noreferrer"`). No hay clave, ni `iframe`, ni cambio de la CSP. **Cambio 2026-11-25**: antes era un
  `<iframe>` de Google Maps Embed con clave opcional `GOOGLE_MAPS_EMBED_KEY`.
- **Rationale**: cumple lo que necesita el paciente (consultar dónde queda) sin clave, facturación ni cuota de un
  tercero, y sin ampliar la superficie de la CSP.
- **Alternatives**: `<iframe>` de Google Maps Embed (requiere clave, facturación y restricción por referente);
  OpenStreetMap incrustado (pide coordenadas: geocodificar y guardar latitud y longitud, migración nueva); mapa
  estático generado por el servidor (otra API de pago y almacenamiento).

### 12. Límites contra el abuso
- **Decision**: por IP con `@fastify/rate-limit` (ya existe): consulta de correo 10/min, reserva 20/hora, cancelación
  30/hora, páginas públicas 120/min. Por cuenta, contados desde `appointment` en la misma transacción: 5 reservas por hora
  por cuenta, 3 citas vigentes por paciente y consultorio, 10 cancelaciones por hora por cuenta.
- **Rationale**: sin tablas de contadores; los límites por cuenta se hacen respetar bajo el bloqueo del médico (ráfagas
  simultáneas no los eluden). El límite por IP es por instancia (deuda ya anotada en 0002).
- **Alternatives**: contadores en tabla propia (más migraciones, mismo resultado).

### 13. Mis consultorios y revocar
- **Decision**: la revocación es por cuenta y consultorio, en una transacción bajo el bloqueo del médico: cancela las
  citas futuras vigentes de todos los pacientes de la cuenta con ese consultorio (`cancelled_by_role = 'patient'`), encola
  un aviso al médico por cada una y la constancia al paciente, marca `doctor_patient.revoked_at` de todos los pacientes de
  esa cuenta con ese médico y registra la acción. Pantalla de confirmación previa con las consecuencias (número de citas
  que se cancelarán). El correo de vínculo creado por el personal (`patient_linked_by_office`) se encola en la feature 2
  al crear un vínculo con origen `office`.
- **Rationale**: cumple FR-032 y FR-033 con la opción A elegida; un único efecto atómico.
- **Alternatives**: revocar por paciente adicional (más pantallas, la cuenta es la unidad de consentimiento).

### 14. Sesión de paciente en rutas del personal
- **Decision**: las rutas de la feature 2 ya exigen `services.tenants.resolve`, que rechaza el rol paciente (403). No cambia.
- **Rationale**: defensa en profundidad junto con `StaffContext`.

## Pruebas obligatorias (constitución V)

- Concurrencia: 20 reservas simultáneas del mismo horario por pacientes distintos (una prospera); reserva contra
  bloqueo, contra cancelación del personal y contra revocación del vínculo; dos cancelaciones simultáneas de la misma cita.
- Aislamiento: un paciente no ve ni cancela citas de otra cuenta; el micrositio no expone pacientes; una cuenta no puede
  reservar para un paciente de otra cuenta; el personal no puede vincular a quien revocó.
- Tokens: de un solo uso, caducidad, ligado a la cita y a la cuenta; abrir el enlace 100 veces no cambia nada.
- Límites: de cancelación (borde inclusivo), reservas por hora, citas vigentes por consultorio.
- Autorizaciones: la casilla sin marcar bloquea; registro de quién, versión y cuándo; solo anexar.
- Recordatorios: uno solo por cita con cron solapado; ninguno para citas canceladas ni tardías; cambia con el límite.
