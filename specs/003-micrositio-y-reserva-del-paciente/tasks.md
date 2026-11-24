---

description: "Lista de tareas de la feature 003-micrositio-y-reserva-del-paciente"
---

# Tasks: Micrositio del médico y reserva del paciente

**Input**: Documentos de diseño en `/specs/003-micrositio-y-reserva-del-paciente/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS. La constitución (principio V) exige pruebas del comportamiento nuevo, escritas antes o junto con la implementación y **fallando antes de implementar** las reglas de negocio. Cada historia empieza con sus pruebas. Son obligatorias las de concurrencia de reservas, aislamiento, caducidad y uso único de tokens, límite de cancelación y registro de autorizaciones.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US7 de `spec.md`) para implementarlas y probarlas de forma independiente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- Sin `any` salvo justificación en comentario; sin `console.log`; sin secretos en código ni tests.
- Toda entrada externa se valida con zod antes de usarse; SQL siempre parametrizado.
- El médico de cada operación pública sale del `slug` resuelto en el servidor (`site-resolver`), **nunca** de un campo del cliente. La redirección tras iniciar sesión se calcula en el servidor desde el `slug` (sin parámetro libre); solo se conserva la `fecha` (AAAA-MM-DD) validada con zod, y si es inválida se ignora.
- Las funciones de agenda del personal exigen `StaffContext`; las que comparten el personal y el paciente (`loadSettings`, solapes, `insertAppointment`, `enqueueEmail`, `logCalendarAction`) aceptan `TenantContext`. Toda función de agenda o de micrositio recibe el contexto como **primer** parámetro.
- Toda mutación de la agenda de un médico pasa por `withCalendarLock` y dentro solo se usa la conexión de esa transacción (nunca otra del pool).
- Las lecturas de la tabla `patient` viven solo en `src/modules/patients/patient-repository.ts` (lo audita `tests/integration/route-audit.test.ts`).
- Los registros técnicos nunca incluyen nombres, correos ni teléfonos; los correos no llevan datos clínicos y su asunto no lleva datos personales.
- Cada tarea termina con `npm run lint && npm run typecheck && npm run test` en verde para lo que toca (vitest por PowerShell con ruta `C:\…`; el conjunto completo tarda ~25 minutos: correrlo en segundo plano y sin editar código mientras corre).
- Las pruebas con fechas usan `FixedClock`; **fijar el reloj antes de abrir las sesiones** (caducan por inactividad). `t.transport.sent` es compartido por las pruebas de un archivo: vaciarlo en `beforeEach`.
- Commits pequeños, mensaje en imperativo, uno por tarea o grupo lógico.
- No se instalan dependencias (el plan no añade ninguna). No se editan `.env*`, lockfiles ni `secrets/`.

---

## Phase 1: Setup

**Purpose**: confirmar el punto de partida y declarar la configuración nueva.

- [x] T001 Confirmar que `npm run lint && npm run typecheck`, las migraciones `0001`–`0010` y las pruebas de las features 1 y 2 están en verde y que `git status` está limpio antes de empezar. Sin cambios de código.
- [x] T002 [P] Añadir a `src/config/env.ts` las variables opcionales `LOGO_STORAGE_DIR` (por defecto `<CEDULA_STORAGE_DIR>/logos`) y `GOOGLE_MAPS_EMBED_KEY` (cadena de al menos 10 caracteres; sin ella el mapa se omite); casos nuevos en `tests/unit/env.test.ts` (valor por defecto del directorio, clave vacía o demasiado corta rechazada, el mensaje de error no incluye el valor); documentarlas en `docs/configuration.md` (propósito, ejemplo ficticio, opcionales, cuota diaria y restricción por referente de la clave en el proveedor). **No editar `.env.example`**: dejar la nota para que el usuario lo actualice a mano.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: esquema, tipos de contexto, correo con `Reply-To`, tokens de cita, vínculos con revocación, reglas puras y andamiaje. TODAS las historias dependen de esta fase.

**CRITICAL**: ninguna historia puede empezar hasta terminarla.

- [x] T003 Crear `migrations/0011_site.sql` con lo de `data-model.md`, citando sus restricciones: tabla `doctor_site` (`doctor_id` BIGINT UNSIGNED PK FK `doctor`; `slug` VARCHAR(40) NOT NULL **UNIQUE** con CHECK de longitud 3–40; `address` VARCHAR(300) NULL; `logo_file` VARCHAR(64) NULL; `status` ENUM('draft','published','unpublished') por defecto `draft`; `first_published_at`, `published_at` DATETIME(3) NULL; `created_at`, `updated_at` DATETIME(3)); tabla `data_authorization` (`id` PK; `account_id` FK `patient_account`; `doctor_id` FK `doctor`; `given_by_user_id` FK `user`; `legal_document_id` FK `legal_document`; `accepted_at` DATETIME(3); índice `(account_id, doctor_id, accepted_at)`) con disparadores `BEFORE UPDATE` y `BEFORE DELETE` de una sola sentencia (`SIGNAL SQLSTATE '45000'`, mismo patrón que `consent_acceptance`); `ALTER` de `doctor_patient` (`origin` ENUM('patient','office') NOT NULL por defecto `office`; `created_by_user_id` BIGINT UNSIGNED NULL FK `user`; `revoked_at` DATETIME(3) NULL); `calendar_settings.cancel_notice_hours` SMALLINT UNSIGNED NOT NULL por defecto 24 con CHECK 0–168; `appointment.reminder_enqueued_at` DATETIME(3) NULL con índice `(status, reminder_enqueued_at, start_utc)`; `MODIFY` de `appointment.created_by_role` y `appointment.cancelled_by_role` a ENUM('doctor','reception','patient') (la de cancelación sigue NULL), de `calendar_action_log.actor_role` a ENUM('doctor','reception','patient') y de `calendar_action_log.action` con `site_updated`, `data_authorized`, `link_revoked`; `one_time_token.purpose` con `appointment_confirmation` y `appointment_reminder` (conservando los valores actuales) y la columna `appointment_id` BIGINT UNSIGNED NULL FK `appointment`. Comprobar primero los valores actuales de cada ENUM en las migraciones `0001`–`0010` antes de ampliarlos.
- [x] T004 [P] Escribir `tests/integration/site-schema.test.ts` y ampliar `tests/integration/append-only.test.ts` (`data_authorization` en `TABLES`, con sus disparadores `data_authorization_no_delete` y `data_authorization_no_update`, su `seed` y `updateSql`, y en la expresión regular que prohíbe `UPDATE`/`DELETE` en `src`) y `tests/integration/migrate.test.ts` (los dos disparadores nuevos en la lista ordenada por nombre): la migración `0011` es idempotente; `doctor_site.slug` rechaza un duplicado (1062) y longitudes 2 y 41; `cancel_notice_hours` rechaza 169; los ENUM aceptan `patient`; `one_time_token` acepta `appointment_confirmation` con `appointment_id`; `data_authorization` rechaza `UPDATE` y `DELETE`; los vínculos existentes quedan con `origin = 'office'`.
- [x] T005 [P] Ampliar `src/lib/tenant.ts`: `TenantActor` gana `{ kind: "patient"; userId }`; nuevo tipo `StaffContext` (contexto cuyo actor es médico o recepción), guarda de tipo `isStaffContext`, y `createPatientContext(doctorId, userId)` documentado como llamable **solo** desde `site-resolver`. Actualizar `tests/unit/tenant.test.ts`: el contexto de paciente se distingue del del personal, `isStaffContext` lo rechaza, no se puede fabricar con un objeto literal.
- [x] T006 Cambiar a `StaffContext` (primer parámetro) las funciones de la feature 2 que muestran o cambian datos del consultorio: `src/modules/calendar/agenda-service.ts`, `appointment-service.ts` (`cancelAppointment` del personal, `describeFreeSlot`), `block-service.ts`, `block-repository.ts`, `appointment-repository.ts` (lecturas con nombre), `settings-repository.ts` (`saveSettings`), `patient-picker.ts`, `action-log.ts` (`assertWithinAppointmentLimits` con paciente solo se usa del lado del personal) y `src/modules/calendar/routes.ts` (las rutas ya obtienen el contexto de `services.tenants.resolve`, que devuelve `StaffContext`); `createTenantResolver` (`src/modules/reception/tenant-resolver.ts`) devuelve `StaffContext`. Las funciones `…ForDoctor` de `patient-repository.ts` se tratan en T014 (no se tocan aquí). Ajustar `tests/integration/route-audit.test.ts` (primer parámetro `ctx: TenantContext` **o** `ctx: StaffContext`). No debe cambiar ningún comportamiento: las 899 pruebas existentes pasan.
- [x] T007 [P] Añadir `replyTo?: string` a `MailMessage` (`src/mail/transport.ts`, transporte SMTP y en memoria) y a `RenderedEmail` (`src/mail/templates.ts`), y que `processOutbox` (`src/mail/outbox.ts`) lo pase al enviar; pruebas en `tests/integration/outbox.test.ts` y `tests/unit/smtp-transport.test.ts` (el transporte SMTP recibe `replyTo`; sin él, el comportamiento es el de antes; el `replyTo` no se guarda en el outbox).
- [x] T008 [P] Ampliar `src/modules/auth/one-time-tokens.ts`: `TokenPurpose` gana `appointment_confirmation` y `appointment_reminder`; `TokenSubject` y `create/peek/consume` admiten `appointmentId` como sujeto (con `user_id <=> ?` y `appointment_id <=> ?` en la invalidación del mismo propósito y sujeto); `EmailTemplate.token.subject` de `src/mail/templates.ts` devuelve también `appointmentId`; pruebas nuevas en `tests/integration/one-time-tokens.test.ts` (token de cita de un solo uso, caducidad, ligado a la cita, `peek` no consume, un propósito no invalida al otro, una cita no invalida los tokens de otra).
- [x] T009 [P] Escribir `tests/unit/site-slug.test.ts` (debe fallar antes de implementar): acepta `clinica-sonrisa`, `a1b`, `dr-lopez-2`, 3 y 40 caracteres; rechaza 2 y 41 caracteres, mayúsculas, acentos, espacios, `_`, `-abc`, `abc-`, `a--b`, vacío, solo números permitidos solo si cumple longitud (`123` válido), y entradas con `/`, `.` o `%`; `normalizeSlug` recorta espacios y pasa a minúsculas solo para mostrar el error, nunca para aceptar un nombre con mayúsculas.
- [x] T010 Implementar `src/lib/site-slug.ts` con `SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/`, `isValidSlug` y los mensajes en español de las reglas. T009 debe pasar.
- [x] T011 [P] Escribir `tests/unit/reminder-time.test.ts` (debe fallar antes de implementar): con límite de 24 h el recordatorio es 30 h antes del inicio; con 48 h, 54 h antes; con 0 h, 6 h antes; `isReminderDue(now, appointment)` es verdadero desde ese momento hasta el inicio y falso después; falso si la cita se creó **después** del momento del recordatorio; falso si ya pasó el inicio.
- [x] T012 Implementar `src/lib/reminder-time.ts` (`reminderMoment(startUtc, cancelNoticeHours)` = inicio − (límite + 6 h) y `isReminderDue`). T011 debe pasar.
- [x] T013 [P] Escribir `tests/integration/patient-link-revocation.test.ts` (debe fallar antes de implementar): los vínculos de `doctor_patient` con `revoked_at` no aparecen en `findPatientForDoctor`, `listPatientsForDoctor`, `findTutorForMinor` ni en `findNotificationEmailForDoctor`; sí aparecen en `listPatientNamesForDoctor` (nombres de las citas pasadas); `linkPatientToDoctor` desde el personal con un vínculo revocado lanza `NotFoundError` y no cambia nada; `linkPatientToDoctor` con `origin: 'patient'` reactiva el vínculo (`revoked_at = NULL`) y conserva el historial; vínculos nuevos guardan `origin` y `created_by_user_id`; aislamiento entre médicos intacto. Actualizar `tests/integration/tenant-isolation.test.ts` si cambian firmas.
- [x] T014 Implementar la revocación en `src/modules/patients/patient-repository.ts` (filtro `dp.revoked_at IS NULL` en todas las lecturas de contacto y `findNotificationEmailForDoctor`; `listPatientNamesForDoctor` sin ese filtro) y `src/modules/patients/link-service.ts` (`linkPatientToDoctor(executor, doctorId, patientId, options?)` con `origin`, `createdByUserId` y la regla de que el personal no reactiva un vínculo revocado); las funciones `…ForDoctor` que usa el personal pasan a `StaffContext`; añadir además aquí **todas** las lecturas de `patient` que necesita el flujo del paciente, para que la auditoría de rutas se mantenga (`patient` solo se lee en este archivo): `findPatientOfAccount(accountId, patientId)`, `listAccountPatientIds(accountId)` y `listAccountPatientIdsLinkedToDoctor(ctx, accountId)` (los pacientes de la cuenta con vínculo activo con ese médico), con sus pruebas en `tests/integration/patient-link-revocation.test.ts`. T013 debe pasar.
- [x] T015 [P] Escribir `tests/integration/site-resolver.test.ts` (debe fallar antes de implementar): `resolveSite(slug)` devuelve el estado y el médico solo para `published` con médico `approved`; `draft` y desconocido son indistinguibles (`null`); `unpublished` o médico no aprobado devuelven el aviso mínimo (nombre del consultorio y teléfono); `resolvePatientSite(request, slug)` exige sesión de paciente y devuelve el contexto de paciente con el médico del `slug` (nunca de un parámetro); médico, recepción y soporte con sesión reciben 403.
- [x] T016 Implementar `src/modules/site/site-repository.ts` (`insertSiteName`, `getSiteBySlug`, `getSiteByDoctor`, `updateAddress`, `setLogo`, `setStatus`, siempre con `ctx` primero si son del médico) y `src/modules/site/site-resolver.ts` (única vía que llama a `createPatientContext`). T015 debe pasar.
- [x] T017 [P] Ampliar `tests/integration/helpers/db.ts` y `helpers/app.ts`: `createDoctorSite(pool, doctorId, { slug?, status?, address? })`, `createPublishedSite(pool, doctor)` (con dirección, teléfono del consultorio y horario), `createDataAuthorization(pool, { accountId, doctorId, userId })`, `createDependent(pool, accountId, fullName)` y `patientClientFor(t, pool, options)` (cuenta de paciente con sesión y token CSRF, y su cuenta y paciente).
- [x] T018 [P] Crear `src/http/views/site.ts` con el diseño común de las pantallas del micrositio y de paciente (escape obligatorio, hora y fecha en la zona del consultorio, avisos) y un gancho `onSend` en `src/http/app.ts` que añade `X-Robots-Tag: noindex, nofollow` a las rutas `/c/`, `/citas/` y `/pacientes/`; pruebas en `tests/unit/site-views.test.ts` y `tests/contract/site-noindex.test.ts` (la cabecera y la meta `noindex` están en todas las respuestas del micrositio, incluido el 404).
- [x] T019 Crear los registros vacíos `registerSitePublicRoutes`, `registerSiteDoctorRoutes` y `registerSitePatientRoutes` (`src/modules/site/public-routes.ts`, `doctor-routes.ts`, `patient-routes.ts`) y cablearlos en `src/compose.ts` (servicios `site` en `Services`); `tests/contract/site-access.test.ts` (debe fallar antes): un `slug` inexistente responde 404 con el mismo cuerpo que una ruta cualquiera; sesiones de rol no permitido reciben 403 en `/medicos/micrositio`.

**Checkpoint**: la base existe; las historias pueden empezar.

---

## Phase 3: User Story 1 - El médico publica su micrositio (Priority: P1) 🎯 MVP

**Goal**: el médico elige el nombre de su enlace, captura dirección y logo, define el límite de cancelación, publica y despublica; cualquiera ve el micrositio.

**Independent Test**: con un médico aprobado con horario y teléfono, elegir nombre, capturar dirección, publicar, abrir `/c/<nombre>` sin sesión y comprobar que se ve el consultorio; despublicar y comprobar el aviso.

### Tests for User Story 1

- [x] T020 [P] [US1] Escribir `tests/unit/logo-storage.test.ts` (debe fallar antes de implementar): acepta PNG, JPEG y WebP por su **firma de bytes**; rechaza SVG, GIF, PDF, un archivo vacío, uno de más de 1 MB (`1048576` bytes es el máximo), un `.png` con contenido de otro tipo y un archivo con firma de imagen seguido de contenido de script; el nombre guardado cumple `^[a-f0-9]{32}\.(png|jpg|webp)$`; `read` rechaza nombres con `..` o `/`.
- [x] T021 [P] [US1] Escribir `tests/integration/site-service.test.ts` (debe fallar antes de implementar): elegir nombre una sola vez (segundo intento 409); dos médicos con el mismo nombre a la vez: uno lo obtiene y el otro `slug_taken` (unicidad por el índice, sin `SELECT … FOR UPDATE` sobre un rango vacío); publicar exige médico aprobado, `address`, `office_phone` y al menos una franja en `calendar_hours`, y devuelve la lista de lo que falta; despublicar conserva citas y bloqueos; `first_published_at` se fija solo la primera vez; recepción, médico pendiente, rechazado y paciente reciben 403; cada cambio registra `site_updated` con quién y cuándo.
- [x] T022 [P] [US1] Escribir `tests/contract/site-doctor.test.ts` (debe fallar antes de implementar) con las 7 rutas del médico de `contracts/http-routes.md`: `GET /medicos/micrositio`, `POST …/nombre`, `POST …`, `POST …/logo` (multipart), `POST …/logo/quitar`, `POST …/publicar`, `POST …/despublicar`; validación 400, 403 por rol, CSRF 403, 409 `slug_taken` y 409 con la lista de lo que falta al publicar; el médico sale de la sesión (un `doctorId` en el cuerpo se ignora).
- [x] T023 [P] [US1] Escribir `tests/contract/site-public.test.ts` (debe fallar antes de implementar): `GET /c/:slug` publicado muestra nombre, dirección (o mapa si hay clave), teléfono, logo y las dos opciones sin horarios ni datos de pacientes; `draft` o inexistente: **404 idéntico**; `unpublished` o médico no aprobado: aviso con nombre y teléfono sin calendario; `GET /c/:slug/logo` solo con micrositio publicado y logo, con `X-Content-Type-Options: nosniff`; CSP con `frame-src` del proveedor solo si hay clave y solo en esta ruta; el pie enlaza el aviso de privacidad; límite de peticiones por IP (120/min).
- [x] T024 [P] [US1] Ampliar `tests/unit/calendar-settings.test.ts`, `tests/integration/calendar-settings-write.test.ts` y `tests/contract/calendar-settings.test.ts` para `cancelNoticeHours` (0–168, entero, por defecto 24; 169 y `-1` rechazados con mensaje por campo; el JSON de `GET /agenda/configuracion` lo incluye; cambiarlo no toca citas existentes) (deben fallar antes de implementar).

### Implementation for User Story 1

- [x] T025 [US1] Implementar `src/modules/site/logo-storage.ts` (firma PNG/JPEG/WebP, 1 MB, nombre aleatorio, directorio `LOGO_STORAGE_DIR`, `save`, `read`, `remove`; modelo: `src/modules/doctors/cedula-storage.ts`). T020 debe pasar.
- [x] T026 [US1] Implementar `src/modules/site/site-service.ts` (`chooseName`, `saveAddress`, `replaceLogo`, `removeLogo`, `publish`, `unpublish`; reglas de publicación; registro `site_updated` en `calendar_action_log`; solo `StaffContext` de médico). T021 debe pasar.
- [x] T027 [US1] Añadir `cancelNoticeHours` a la configuración del calendario: `src/modules/calendar/settings.ts` (esquema y valor por defecto 24), `settings-repository.ts` (lectura y guardado), `src/http/views/calendar.ts` (campo en el formulario) y `src/modules/calendar/routes.ts` (JSON de `GET /agenda/configuracion`); actualizar `specs/002-calendario-del-medico/contracts/http-routes.md`. T024 debe pasar.
- [x] T028 [US1] Añadir a `src/http/views/site.ts` la página del micrositio (con `<iframe>` del mapa si hay `GOOGLE_MAPS_EMBED_KEY`, si no la dirección en texto), el aviso de micrositio sin reservas y la pantalla «Mi micrositio» del médico (estado, enlace, pasos que faltan).
- [x] T029 [US1] Implementar las rutas del médico en `src/modules/site/doctor-routes.ts` y añadir `/medicos/micrositio/logo` a `MULTIPART_ROUTES` en `src/http/app.ts`; enlazar «Mi micrositio» desde `/medicos/inicio`. T022 debe pasar.
- [x] T030 [US1] Implementar `GET /c/:slug` y `GET /c/:slug/logo` en `src/modules/site/public-routes.ts` (404 uniforme, aviso, CSP del mapa solo aquí, caché corta del logo, límite de peticiones por IP). T023 debe pasar.

**Checkpoint**: US1 funciona sola: un médico publica y el consultorio es visible.

---

## Phase 4: User Story 2 - El paciente abre el micrositio y entra a su cuenta (Priority: P1)

**Goal**: «Ya soy paciente» y «Primera cita» con las reglas de la feature 1, solo cuentas de paciente, sin redirecciones abiertas.

**Independent Test**: sin sesión, abrir el micrositio, entrar con una cuenta existente y con una nueva y llegar en ambos casos al calendario (`/c/:slug/reservar`).

### Tests for User Story 2

- [x] T031 [P] [US2] Escribir `tests/integration/entry-service.test.ts` (debe fallar antes de implementar): `signIn` con contraseña correcta crea la sesión de paciente; incorrecta registra el fallo en la espera creciente compartida con `/login` (misma `accountKey`); un correo de médico, recepción o soporte devuelve `no_account` (indistinguible de uno inexistente); cuenta desactivada: `invalid_credentials`; `registerFirstAppointment` crea cuenta y paciente, registra la aceptación del aviso vigente y abre sesión; sin la casilla: `ValidationError`; correo ya registrado: mensaje con salida a «Ya soy paciente».
- [x] T032 [P] [US2] Escribir `tests/contract/site-entry.test.ts` (debe fallar antes de implementar): `GET/POST /c/:slug/entrar` (303 a `/c/:slug/reservar`, 401 `invalid_credentials`, 401 `no_account` con la opción «Primera cita»), `GET/POST /c/:slug/primera-cita` (303; 400 sin casilla; casilla sin marcar de antemano); el destino del 303 sale del `slug`, no de un parámetro (`?next=https://malo.example` se ignora); micrositio despublicado: no permite entrar para reservar (aviso); límite de 10 intentos por minuto por IP (el 11.º, 429); con sesión de paciente `GET /c/:slug` redirige a `/c/:slug/reservar`; con sesión de otro rol se ve el micrositio sin poder reservar; un `?fecha=2026-07-01` válido se conserva tras iniciar sesión o registrarse y uno inválido o con otro formato se ignora.

### Implementation for User Story 2

- [x] T033 [US2] Extraer de `src/modules/auth/routes.ts` a `src/modules/auth/login-service.ts` la verificación de credenciales (espera creciente por cuenta e IP, mismo trabajo de hash exista o no la cuenta, nuevo dispositivo, rehash, sesión nueva) **sin cambiar el comportamiento**; `/login` pasa a usar el servicio; `tests/contract/login.test.ts`, `mfa.test.ts` y `new-device.test.ts` deben seguir pasando sin cambios.
- [x] T034 [US2] Implementar `src/modules/site/entry-service.ts` (`signIn(slug, email, password, ip)` solo para rol `patient`, y `registerFirstAppointment` sobre `services.patients.register`). T031 debe pasar.
- [x] T035 [US2] Implementar en `src/modules/site/public-routes.ts` y `src/http/views/site.ts` las rutas `entrar` y `primera-cita` (formularios con CSRF anónimo, casilla de privacidad sin marcar, límite de peticiones) y la redirección a `/c/:slug/reservar` calculada en el servidor, conservando solo la `fecha` validada con zod para volver al mismo día tras iniciar sesión. T032 debe pasar.

**Checkpoint**: US1 + US2: el médico publica y el paciente entra.

---

## Phase 5: User Story 3 - El paciente reserva una cita (Priority: P1)

**Goal**: calendario sin fechas pasadas, horarios libres, reserva para sí o para pacientes adicionales con autorización de datos, sin doble reserva.

**Independent Test**: reservar un horario libre y comprobar que queda ocupado en la agenda del médico; 20 reservas simultáneas del mismo horario dejan una; manipular la petición no salta las reglas.

### Tests for User Story 3

- [x] T036 [P] [US3] Escribir `tests/integration/availability-view.test.ts` (debe fallar antes de implementar): el mes marca habilitados solo los días con horarios libres que cumplen la anticipación; no hay días pasados ni posteriores a la anticipación máxima; los bloqueos y las citas quitan horarios; el cálculo del mes usa **una** consulta de citas y una de bloqueos; el cambio de hora (America/Tijuana) no duplica ni pierde horarios; los horarios del día vienen en la hora del consultorio; el mes (con 300 citas y 20 bloqueos) se calcula en menos de 2 segundos (SC-008).
- [x] T037 [P] [US3] Escribir `tests/integration/booking-service.test.ts` (debe fallar antes de implementar): reserva exitosa (cita `booked`, `created_by_role = 'patient'`, vínculo `origin = 'patient'`, autorización registrada, acción registrada); rechaza fuera de la anticipación mínima y máxima (bordes inclusivos con `validatePatientBookingWindow`), horario inexistente en la configuración, ocupado, bloqueado, pasado y micrositio despublicado o médico no aprobado (403); paciente de otra cuenta (404); límites: 5 reservas por hora por cuenta (contadas desde `appointment`) y 3 citas vigentes por paciente y consultorio; sin la casilla `autorizo` cuando no hay autorización activa (400) y sin pedirla cuando ya existe; cita de un menor a nombre del menor con la autorización del tutor; reactiva un vínculo revocado con nueva autorización; **doble envío**: una segunda petición idéntica de la misma cuenta para el mismo horario no crea otra cita ni otro correo y devuelve la cita ya creada; al pedir la casilla queda `data_authorized` en `calendar_action_log`.
- [x] T038 [P] [US3] Escribir `tests/integration/booking-concurrency.test.ts` (**obligatoria por la constitución**; debe fallar antes de implementar): 20 reservas simultáneas del mismo horario por pacientes distintos → exactamente una cita y 19 `slot_unavailable`; reserva contra bloqueo del médico (nunca una cita dentro de un bloqueo; 20 rondas); reserva contra cancelación del personal sobre el mismo horario; una ráfaga de 8 reservas de la misma cuenta deja pasar exactamente 5 (el límite por hora no se elude).
- [x] T039 [P] [US3] Escribir `tests/integration/data-authorization.test.ts` (debe fallar antes de implementar): `recordAuthorization` guarda cuenta, consultorio, quién, versión del aviso de privacidad vigente y fecha en la misma transacción que la cita; «activa» = existe una autorización posterior a la última revocación; la tabla es de solo anexar; sin documento legal vigente no se puede reservar; la autorización la da el tutor (el usuario de la cuenta) también para un menor; cada autorización nueva deja una fila `data_authorized` en `calendar_action_log` con quién y cuándo.
- [x] T040 [P] [US3] Escribir `tests/contract/site-booking.test.ts` (debe fallar antes de implementar): `GET /c/:slug/reservar` (sin sesión, 303 a `/c/:slug`; con sesión muestra el mes y, con `fecha`, los horarios; sin fechas pasadas), `POST /c/:slug/reservar` (303 a `/pacientes/citas/:id`; 409 `slot_unavailable` con los horarios actualizados; 400 con horario inexistente o sin casilla; 403 con micrositio despublicado; 404 con paciente de otra cuenta; 429 con `Retry-After`; sin CSRF 403; el médico sale del `slug`, un `doctorId` en el cuerpo se ignora), `GET/POST /c/:slug/paciente-adicional` (añade un paciente adicional y regresa a reservar); límite de 20 reservas por hora por IP; el horario ofrecido en el navegador pero ya ocupado se rechaza; el doble envío del mismo formulario da 303 a la cita ya creada; `GET /agenda/citas/:id` y la agenda del médico (feature 2) muestran la cita como creada por «el paciente» (`createdByRole = 'patient'`).

### Implementation for User Story 3

- [x] T041 [US3] Factorizar en `src/modules/calendar/appointment-service.ts` la validación común a ambos caminos (`resolveSlot`, horario futuro, solape con citas y con bloqueos) en una función interna `assertSlotBookable(ctx, connection, startLocal, now)` que usan `createAppointment` (personal) y la reserva del paciente; **sin cambiar el comportamiento** (las pruebas de la feature 2 deben seguir pasando).
- [x] T042 [US3] Implementar `src/modules/site/authorization.ts` (`recordAuthorization`, `hasActiveAuthorization`; `data_authorization` de solo anexar con la versión del aviso vigente). T039 debe pasar.
- [x] T043 [US3] Implementar `src/modules/site/availability-view.ts` (mes y día con `listFreeSlots(forPatient: true)`, una consulta de citas y otra de bloqueos del mes; límites de navegación de mes). T036 debe pasar.
- [x] T044 [US3] Implementar `src/modules/site/booking-service.ts` → `reserveAsPatient(ctx, deps, input)` bajo `withCalendarLock` con el orden del `research.md` (decisión 4): micrositio publicado y médico aprobado, paciente de la cuenta, límites, horario y anticipaciones con `validatePatientBookingWindow`, solapes, autorización y vínculo (`origin: 'patient'`), inserción con `created_by_role = 'patient'`, registro de la acción (`appointment_created`); el traductor del error 1062 a `slot_unavailable`. Usa `findPatientOfAccount` y las lecturas de T014 (nunca lee `patient` fuera de `patient-repository.ts`), trata el doble envío de la misma cuenta como idempotente, registra `data_authorized` además de `appointment_created`, y añade `'patient'` a `createdByRole` en `AppointmentRecord` (`src/modules/calendar/appointment-repository.ts`). T037 y T038 deben pasar.
- [x] T045 [US3] Implementar en `src/http/views/site.ts` y `src/modules/site/public-routes.ts` el calendario del mes («tipo aerolínea», sin JavaScript), la lista de horarios, la elección de paciente (titular o adicional), el texto de qué datos verá el consultorio con la casilla sin marcar, y las rutas `GET/POST /c/:slug/reservar` y `GET/POST /c/:slug/paciente-adicional` (reutiliza `services.dependents`); el detalle de cita y la agenda del médico (`src/http/views/calendar.ts`) muestran «el paciente» como quien agendó. T040 debe pasar.

**Checkpoint**: US1–US3: se puede reservar sin doble reserva.

---

## Phase 6: User Story 4 - El paciente y el médico reciben sus correos (Priority: P1)

**Goal**: correo de confirmación con enlace y `Reply-To` del médico, aviso al médico, y enlaces que nunca cambian el estado al abrirse.

**Independent Test**: reservar y comprobar los dos correos; abrir el enlace 100 veces (también con otra cuenta) y comprobar que la cita no cambia.

### Tests for User Story 4

- [x] T046 [P] [US4] Escribir `tests/integration/site-emails.test.ts` (debe fallar antes de implementar): al reservar, `appointment_created` llega a la cuenta con fecha, hora en la zona del consultorio, dirección, teléfono, enlace `/citas/enlace/<token>` y `Reply-To` del médico, y `doctor_appointment_booked` llega al correo del médico (no a recepción) con solo el nombre, la fecha, la hora y «convencional»; asuntos sin datos personales; ningún cuerpo con teléfono ni correo del paciente en el aviso al médico; el outbox guarda solo `{ appointmentId }`; la cita cancelada antes del envío cancela `appointment_created`; para un menor el correo va a la cuenta del tutor. Actualizar `tests/integration/appointment-email.test.ts` y `tests/contract/appointment-cancel.test.ts` (feature 2): `appointment_created` ahora lleva enlace, dirección y `Reply-To`; `appointment_cancelled` lleva `Reply-To`.
- [x] T047 [P] [US4] Escribir `tests/integration/appointment-links.test.ts` y `tests/contract/appointment-link.test.ts` (deben fallar antes de implementar): `GET /citas/enlace/:token` valida **sin consumir**: abrirlo 100 veces (con y sin sesión, con otra cuenta, con un cliente automático) no cambia la cita ni el token; sin sesión muestra el inicio de sesión del paciente y, tras `POST /citas/enlace/:token/entrar`, regresa al mismo enlace; otra cuenta, token vencido, usado, manipulado o de una cita cancelada o pasada responden el mismo 410 genérico sin datos; el recordatorio no invalida el enlace de la confirmación; los tokens son por propósito y cita; límite de 60 peticiones por minuto por IP en `/citas/enlace/:token` y `/citas/enlace/:token/entrar` (la 61.ª recibe 429); un token cuya cita ya empezó responde 410 aunque su registro no haya vencido.

### Implementation for User Story 4

- [x] T048 [US4] Implementar `src/modules/site/email-templates.ts` con `doctor_appointment_booked` y registrar las plantillas en `src/mail/templates.ts`; ampliar `src/modules/calendar/email-templates.ts`: `appointment_created` (dirección, enlace con propósito `appointment_confirmation`, `Reply-To` del médico) y `appointment_cancelled` (`Reply-To`). T046 debe pasar.
- [x] T049 [US4] En `src/modules/site/booking-service.ts` y `src/modules/calendar/appointment-service.ts` (`createAppointment` del personal) encolar `appointment_created` y, solo cuando la cita la crea el paciente, `doctor_appointment_booked`, en la misma transacción que la cita.
- [x] T050 [US4] Implementar `src/modules/site/appointment-links.ts` y las rutas `GET /citas/enlace/:token` y `POST /citas/enlace/:token/entrar` en `src/modules/site/patient-routes.ts` con sus vistas (resumen y botón; el botón solo aparece con la sesión de la cuenta dueña). Ambas rutas con límite de 60 peticiones por minuto por IP. T047 debe pasar.

**Checkpoint**: US1–US4: reservar deja constancia por correo y los enlaces son seguros.

---

## Phase 7: User Story 5 - El paciente ve y cancela sus citas (Priority: P2)

**Goal**: «Mis citas» y cancelación hasta el límite del consultorio, desde la pantalla o el enlace; aviso al médico y constancia.

**Independent Test**: cancelar una cita lejana y comprobar horario libre y avisos; cancelar dentro del límite y comprobar el rechazo; cancelar desde el enlace pide sesión y solo el botón cancela.

### Tests for User Story 5

- [x] T051 [P] [US5] Escribir `tests/integration/patient-appointments.test.ts` (debe fallar antes de implementar): «Mis citas» muestra solo las citas de las personas de la cuenta (próximas y de los últimos 90 días), con cualquier consultorio; cancelar con más anticipación que el límite libera el horario, avisa al médico y envía constancia; el borde del límite es **inclusivo** (justo a las 24 h se permite; un minuto después, `cancellation_window_closed` con el teléfono); el límite sale de `cancel_notice_hours` del médico (24 por defecto); ya cancelada o pasada: conflicto sin repetir avisos; cita de otra cuenta: `NotFoundError`; 10 cancelaciones por hora por cuenta; **concurrencia**: dos o tres cancelaciones simultáneas de la misma cita → una prospera, las demás conflicto y un solo aviso; cancelar y reservar el mismo horario a la vez deja como máximo una cita vigente; el paciente puede cancelar (dentro del límite) aunque el micrositio esté despublicado o el médico ya no esté aprobado, y fuera del límite se le indica el teléfono del consultorio; los límites son por cuenta (10 cancelaciones por hora de cualquiera de sus pacientes).
- [x] T052 [P] [US5] Escribir `tests/contract/patient-appointments.test.ts` (debe fallar antes de implementar): `GET /pacientes/citas`, `GET /pacientes/citas/:id` (404 si es de otra cuenta), `POST /pacientes/citas/:id/cancelar` (303, 409 `cancellation_window_closed`, 409 ya cancelada, 404, 429, sin CSRF 403), `POST /citas/enlace/:token/cancelar` (consume el token: la segunda vez 410; con sesión de otra cuenta 410 genérico; sin sesión no cancela); personal y soporte con sesión reciben 403; límite de 30 cancelaciones por hora por IP.

### Implementation for User Story 5

- [x] T053 [US5] Implementar `src/modules/site/patient-appointments.ts` (`listForAccount`, `cancelAsPatient(ctx, deps, input)` bajo `withCalendarLock` del médico de la cita, con el límite por consultorio, el tope por cuenta contado desde `appointment`, `cancelled_by_role = 'patient'`, registro `appointment_cancelled`), añadiendo en `appointment-repository.ts` las consultas por cuenta (sin leer `patient` fuera de `patient-repository.ts`: ids de pacientes de la cuenta con `listAccountPatientIds` de T014). T051 debe pasar.
- [x] T054 [US5] Añadir las plantillas `appointment_cancelled_by_patient` (constancia al paciente, con `Reply-To` del médico) y `doctor_appointment_cancelled` (al correo del médico: nombre, fecha, hora y, si fue por revocación, el motivo) en `src/modules/site/email-templates.ts`, encoladas en la misma transacción de la cancelación.
- [x] T055 [US5] Implementar en `src/modules/site/patient-routes.ts` y `src/http/views/site.ts` las rutas de «Mis citas», el detalle, `POST /pacientes/citas/:id/cancelar` y `POST /citas/enlace/:token/cancelar` (consume el token). T052 debe pasar.

**Checkpoint**: US1–US5: ciclo completo de reservar y cancelar para el paciente.

---

## Phase 8: User Story 6 - El paciente recibe un recordatorio (Priority: P2)

**Goal**: un único recordatorio por cita, 6 horas antes del límite de cancelación, con enlace para cancelar a tiempo.

**Independent Test**: con citas a distintas distancias, ejecutar la tarea programada en distintos momentos y comprobar quién recibe recordatorio, cuándo y cuántas veces.

### Tests for User Story 6

- [x] T056 [P] [US6] Escribir `tests/integration/reminders.test.ts` (debe fallar antes de implementar): una cita a 30 h o menos recibe **un** recordatorio aunque la tarea corra varias veces o **dos procesos a la vez** (la actualización condicional de `reminder_enqueued_at` lo garantiza); no se envía a citas canceladas, ya pasadas ni reservadas con menos anticipación que el momento del recordatorio; con límite de 48 h el recordatorio sale 54 h antes; cambiar el límite recalcula los recordatorios futuros; las citas del personal también reciben recordatorio; el correo lleva el enlace `/citas/enlace/<token>` con propósito `appointment_reminder` (no invalida el de la confirmación) y `Reply-To`; si se cancela entre el encolado y el envío, `shouldSend` lo cancela; `processOutbox` no ejecuta recordatorios (solo el job).

### Implementation for User Story 6

- [x] T057 [US6] Implementar `src/jobs/reminders-service.ts` (`enqueueDueReminders(db, clock)`: selecciona citas vencidas con `reminder_enqueued_at IS NULL`, y por cada una, en transacción, `UPDATE … WHERE reminder_enqueued_at IS NULL AND status = 'booked'` y solo con una fila afectada encola `appointment_reminder`; momento con `src/lib/reminder-time.ts`; lotes de 200) y llamarlo al inicio de `src/jobs/outbox.ts`. T056 debe pasar.
- [x] T058 [US6] Añadir la plantilla `appointment_reminder` (asunto «Recordatorio de tu cita dental», dirección, teléfono, hasta cuándo se puede cancelar; `shouldSend` con `FOR UPDATE` sobre la cita) en `src/modules/site/email-templates.ts` y registrarla.

**Checkpoint**: US1–US6.

---

## Phase 9: User Story 7 - Ver y revocar los consultorios vinculados (Priority: P2)

**Goal**: el paciente ve con qué consultorios tiene vínculo, se entera por correo cuando el personal lo vincula y puede revocarlo (opción A de la spec).

**Independent Test**: con un vínculo creado por el personal, comprobar el aviso, que el paciente lo ve y que al revocarlo se cancelan las citas futuras y el médico ya no accede al detalle.

### Tests for User Story 7

- [x] T059 [P] [US7] Escribir `tests/integration/offices.test.ts` (debe fallar antes de implementar): «Mis consultorios» lista vínculos activos con origen y fecha; `revoke(ctx, accountId, doctorId)` bajo el bloqueo del médico cancela las citas futuras vigentes de **todos los pacientes de la cuenta** con ese consultorio, marca `revoked_at` en todos sus vínculos, encola un aviso al médico por cada cita y la constancia al paciente, registra `link_revoked` y es atómica; las citas pasadas se conservan con su nombre; `findPatientForDoctor` y el detalle devuelven `null`/404 tras revocar; **concurrencia**: revocar y reservar a la vez (nunca queda una cita vigente tras revocar sin una nueva autorización); revocar dos veces: la segunda `NotFoundError`; otra cuenta no puede revocar el vínculo ajeno.
- [x] T060 [P] [US7] Escribir `tests/integration/staff-link-notice.test.ts` (debe fallar antes de implementar; amplía la feature 2): cuando el personal vincula a un paciente con boleto, se encola `patient_linked_by_office` a la cuenta (consultorio, fecha de la cita, qué datos ve y cómo revocar) y el vínculo queda con `origin = 'office'` y `created_by_user_id`; un paciente que revocó ese consultorio no se puede agendar desde el personal (404, sin vínculo ni cita ni correo); tras volver a reservar él mismo, el personal sí puede agendarlo.
- [x] T061 [P] [US7] Escribir `tests/contract/offices.test.ts` (debe fallar antes de implementar): `GET /pacientes/consultorios`, `GET /pacientes/consultorios/:doctorId/revocar` (confirmación con el número de citas que se cancelarán; 404 sin vínculo activo), `POST /pacientes/consultorios/:doctorId/revocar` (303; sin CSRF 403; solo rol paciente); el consultorio revocado responde 404 en `/agenda/pacientes/:id`.

### Implementation for User Story 7

- [x] T062 [US7] Implementar `src/modules/site/offices-service.ts` (`listOffices`, `previewRevocation`, `revoke`) con el efecto atómico de `research.md` (decisión 13), leyendo los pacientes de la cuenta solo con las funciones de T014. T059 debe pasar.
- [x] T063 [US7] En `src/modules/calendar/appointment-service.ts` (`createAppointment` del personal): rechazar con `NotFoundError` si el vínculo está revocado, crear vínculos nuevos con `origin: 'office'` y `createdByUserId`, y encolar `patient_linked_by_office` en la misma transacción cuando se crea (o reactiva) un vínculo; añadir la plantilla en `src/modules/site/email-templates.ts`. T060 debe pasar.
- [x] T064 [US7] Implementar en `src/modules/site/patient-routes.ts` y `src/http/views/site.ts` las rutas y pantallas de «Mis consultorios» y de confirmación de la revocación (qué se cancela y qué deja de ver el consultorio). T061 debe pasar.

**Checkpoint**: las siete historias funcionan.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [x] T065 [P] Escribir `tests/integration/site-isolation.test.ts`: un paciente no ve, cancela ni revoca citas o vínculos de otra cuenta (404 con ids ajenos); el micrositio y sus rutas públicas no devuelven datos de pacientes, ni nombres ni horarios ocupados; el personal con sesión no reserva; el paciente con sesión no entra a `/agenda/…` ni a `/medicos/…` (403); un `doctorId` o `patientId` manipulado no cambia a quién se reserva; recorrer las funciones exportadas de `src/modules/site/` y comprobar que las que tocan datos de un médico reciben el contexto como primer parámetro.
- [x] T066 [P] Escribir `tests/integration/site-log-redaction.test.ts`: tras recorrer los flujos (entrar, registrar, reservar, cancelar, revocar, enlace, recordatorio) los registros técnicos y las filas de `calendar_action_log` no contienen nombres, correos ni teléfonos; el `payload_ref` del outbox solo tiene `appointmentId` (y `reason`); el aviso al médico no incluye teléfono ni correo del paciente.
- [x] T067 Ampliar `tests/integration/route-audit.test.ts`: leer también `specs/003-micrositio-y-reserva-del-paciente/contracts/http-routes.md`; añadir a `PUBLIC_GET` `/c/:slug`, `/c/:slug/logo`, `/c/:slug/entrar`, `/c/:slug/primera-cita`, `/citas/enlace/:token` y las rutas de reserva y de paciente que exigen sesión de paciente (comprobar 303 o 401 según el contrato); verificar que todo `POST` sin CSRF responde 403 (incluidas las rutas multipart nuevas) y que ningún `GET` de `/c/` ni `/citas/` cambia estado (comparar la base antes y después de recorrerlos); extender la comprobación del primer parámetro a `src/modules/site/*.ts`.
- [x] T068 [P] Documentar: `docs/decisions/0004-micrositio.md` (decisiones de `research.md`, valores y límites, riesgos abiertos: mapa de un tercero, límite por IP en memoria, cambio de nombre del enlace por soporte manual, correos que llevan nombre del médico), actualizar `docs/configuration.md` (sección de micrositio, límites, `LOGO_STORAGE_DIR`, `GOOGLE_MAPS_EMBED_KEY`, humo de despliegue), `docs/decisions/0003-calendario.md` (el vínculo con consentimiento y la revocación resuelven el riesgo del boleto) y las notas de cambio en `specs/002-calendario-del-medico/contracts/email-notifications.md`; añadir un procedimiento `scripts/change-site-slug.ts` (pide confirmación y registra la acción) para que soporte cambie el nombre del enlace.
- [x] T069 Ejecutar el conjunto completo de pruebas (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) por PowerShell con ruta `C:\…` en segundo plano, sin editar código mientras corre; corregir fallos; comprobar los escenarios 1–40 de `quickstart.md` y la ausencia de `console.log` y de `any` sin justificar.
- [ ] T070 Revisión independiente antes de dar la feature por terminada: `code-review` y `/security-review` sobre el diff de la feature (con atención a la invariante de no doble reserva del lado del paciente, los tokens y los enlaces, el aislamiento, la revocación atómica, la subida del logo y la CSP del mapa), verificando cada hallazgo antes de aplicarlo; documentar el resultado y corregir.
- [ ] T071 Recorrido manual en navegador con SMTP real (publicar → entrar como paciente nuevo y existente → reservar → ver los correos → adelantar el reloj para el recordatorio → cancelar desde el enlace → revocar un vínculo) y, en el despliegue de pruebas de Hostinger, comprobar la migración `0011` en MariaDB, repetir los escenarios de concurrencia (16), probar el mapa con la clave real y su cuota diaria, y que `jobs:outbox` (cron por minuto) envía los recordatorios. Medir además en el piloto SC-001 (tiempo para reservar), SC-002 (finalización) y SC-005 (entrega de correos en 5 minutos). **Requiere a una persona**; dejar anotado el estado igual que T062 de la feature 2.
- [ ] T072 Verificar que `spec.md` refleja lo implementado (FR y supuestos), actualizar los contratos y `checklists/requirements.md` si algo cambió, y marcar las tareas hechas.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; **bloquea todas las historias**. Orden interno: T003 → T004; T005 → T006 (T006 toca muchos archivos de la feature 2, hacerla sola); T009 → T010; T011 → T012; T013 → T014 (necesita T003 y T006); T015 → T016 (necesita T005 y T014); T017 después de T003 y T016; T018 y T019 al final.
- **US1 (Phase 3)**: depende de la Fase 2. Es el MVP: sin micrositio publicado no hay por dónde reservar.
- **US2 (Phase 4)**: depende de US1 (necesita un micrositio publicado) y de T033 (extraer el inicio de sesión).
- **US3 (Phase 5)**: depende de US2 (necesita la sesión de paciente) y de T041 (factorizar la validación de la feature 2).
- **US4 (Phase 6)**: depende de US3 (los correos se encolan al reservar) y de T007 y T008.
- **US5 (Phase 7)**: depende de US4 (usa los enlaces y `appointment_cancelled_by_patient`).
- **US6 (Phase 8)**: depende de US4 (plantillas y tokens) y de T012; puede ir en paralelo con US5.
- **US7 (Phase 9)**: depende de US3 (vínculos y autorización) y de US5 (cancelación con avisos); puede ir en paralelo con US6.
- **Polish (Phase 10)**: depende de todas las historias.

### Within Each User Story

- Pruebas primero y **deben fallar** antes de implementar la regla de negocio.
- Repositorio → servicio → vistas → rutas.
- Cada historia termina con su punto de control y un commit antes de pasar a la siguiente.

### Parallel Opportunities

- Fase 2: T002, T004, T007, T008, T009, T011, T013, T015, T017 y T018 son paralelizables entre sí tras sus dependencias (T005 y T006 van en serie y primero).
- Dentro de cada historia, las pruebas marcadas [P] (archivos distintos) pueden escribirse en paralelo.
- `src/http/views/site.ts`, `public-routes.ts`, `patient-routes.ts` y `email-templates.ts` los tocan varias historias: aplicar esas tareas de una en una.
- No se debe ejecutar la suite de base de datos de forma concurrente en varios procesos.

---

## Implementation Strategy

### MVP First (US1 → US2 → US3)

1. Fase 1 y Fase 2 completas.
2. US1: el médico publica el micrositio.
3. US2: el paciente entra.
4. US3: el paciente reserva sin doble reserva.
5. **Detenerse y validar**: reservar de punta a punta (sin correos todavía); luego US4 para la constancia.

### Incremental Delivery

1. Base + US1 → micrositio visible.
2. US2 + US3 → se puede reservar.
3. US4 → correos y enlaces seguros.
4. US5 → cancelación del paciente.
5. US6 y US7 → recordatorios y privacidad (en paralelo).
6. Polish → aislamiento, registros, auditoría de rutas, revisiones y recorrido manual.

### Notas

- Urgencias y triaje son la feature 4; WhatsApp, cobro y panel de soporte completo quedan fuera. El cambio del nombre del enlace lo hace soporte con `scripts/change-site-slug.ts` (T068).
- Esta feature cambia comportamiento de la feature 2 en tres puntos (T006 `StaffContext`, T048 correos con enlace y `Reply-To`, T063 vínculos con origen y revocación): sus pruebas se actualizan en esas tareas.
- Tareas que requieren a una persona: T071 (navegador, SMTP real y Hostinger).
