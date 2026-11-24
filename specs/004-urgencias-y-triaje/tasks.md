---

description: "Lista de tareas de la feature 004-urgencias-y-triaje"
---

# Tasks: Urgencias y triaje

**Input**: Documentos de diseño en `/specs/004-urgencias-y-triaje/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS. La constitución (principio V) exige pruebas del comportamiento nuevo, escritas antes o junto con la implementación y **fallando antes de implementar** las reglas de negocio. Cada historia empieza con sus pruebas. Son obligatorias las de concurrencia de reservas, aislamiento, límites de urgencia y la de que **la categoría nunca se persiste fuera de la cola de envío**.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US7 de `spec.md`) para implementarlas y probarlas de forma independiente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- Sin `any` salvo justificación en comentario; sin `console.log`; sin secretos en código ni tests.
- Toda entrada externa se valida con zod antes de usarse; SQL siempre parametrizado.
- **La categoría del triaje y las señales de alarma NO se guardan** en ninguna tabla, registro técnico, métrica, URL, cookie ni campo oculto: la categoría solo vive en `email_outbox.payload_ref` de `doctor_urgent_notice` y se elimina al llegar a un estado final o a las 24 h. Los mensajes de error de validación no devuelven el valor de `categoria` recibido.
- El médico de cada operación sale del `slug` resuelto en el servidor (`site-resolver`), **nunca** de un campo del cliente. Toda función de agenda o de urgencias recibe el contexto como **primer** parámetro.
- Toda mutación de la agenda de un médico pasa por `withCalendarLock` y dentro solo se usa la conexión de esa transacción (nunca otra del pool). Una urgencia usa `assertSlotBookable` y el índice único de cita vigente como respaldo.
- Las lecturas de la tabla `patient` viven solo en `src/modules/patients/patient-repository.ts` (lo audita `tests/integration/route-audit.test.ts`).
- Los avisos de urgencia no se bloquean por cuota; los correos no llevan datos clínicos y su asunto no lleva datos personales.
- Cada tarea termina con `npm run lint && npm run typecheck && npm run test` en verde para lo que toca (vitest por PowerShell con ruta `C:\…`, scripts en archivo `.ps1` si hacen falta variables; el conjunto completo tarda ~40 minutos: correrlo en segundo plano y sin editar código mientras corre).
- Las pruebas con fechas usan `FixedClock`; **fijar el reloj antes de abrir las sesiones** (caducan por inactividad). `t.transport.sent` es compartido por las pruebas de un archivo: vaciarlo en `beforeEach`. Las pruebas **inyectan el verificador de CAPTCHA falso**; nunca llaman al proveedor.
- Escribir archivos con la herramienta Write o con scripts `.mjs` (los heredocs de bash con comillas fallan). Los `helpers` de pruebas (`tests/integration/helpers/db.ts` y `app.ts`) se amplían en T011 y T016.
- Commits pequeños, mensaje en imperativo, uno por tarea o grupo lógico.
- No se instalan dependencias (el plan no añade ninguna). No se editan `.env*`, lockfiles ni `secrets/`.

---

## Phase 1: Setup

**Purpose**: confirmar el punto de partida y declarar la configuración nueva.

- [x] T001 Confirmar que `npm run lint && npm run typecheck`, las migraciones `0001`–`0012` y las pruebas de las features 1 a 3 están en verde y que `git status` está limpio antes de empezar (la feature 3 está en `4bde8a4`; siguen pendientes de ella T070, T071 y T072, que no bloquean esta). Sin cambios de código.
- [x] T002 [P] Añadir a `src/config/env.ts` las variables opcionales `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY` (cadenas de al menos 10 caracteres; **ambas o ninguna**: una sola es un error de configuración con mensaje que no incluye el valor); casos nuevos en `tests/unit/env.test.ts` (ambas válidas, ninguna válida, solo una rechazada, valor demasiado corto rechazado, el mensaje de error no contiene el secreto); documentarlas en `docs/configuration.md` (sin ellas la urgencia no se ofrece en producción; en desarrollo el paso del CAPTCHA se omite; claves de prueba oficiales de Turnstile para desarrollo).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: esquema, tipos de franja, búsqueda del espacio más próximo, contenido del triaje, outbox con claves sensibles, CAPTCHA y ayudantes de pruebas. TODAS las historias dependen de esta fase.

**CRITICAL**: ninguna historia puede empezar hasta terminarla.

- [x] T003 Crear `migrations/0013_urgent.sql` con lo de `data-model.md`, citando sus restricciones: `ALTER TABLE calendar_hours ADD COLUMN kind ENUM('regular','urgent') NOT NULL DEFAULT 'regular'`; `ALTER TABLE calendar_settings ADD COLUMN urgent_min_notice_minutes INT UNSIGNED NOT NULL DEFAULT 30` con `CONSTRAINT ck_calendar_urgent_notice CHECK (urgent_min_notice_minutes BETWEEN 0 AND 1440)`; `ALTER TABLE appointment MODIFY kind ENUM('regular','urgent') NOT NULL DEFAULT 'regular'`; `ALTER TABLE calendar_action_log MODIFY action ENUM('settings_updated','appointment_created','appointment_cancelled','block_created','block_removed','block_rejected','patient_lookup','site_updated','data_authorized','link_revoked','urgent_requested') NOT NULL` (todos los valores previos más el nuevo; sin tocar los disparadores de solo anexar); sin índices nuevos (`idx_calendar_log_actor (actor_user_id, action, occurred_at)` de `0009` ya cubre el conteo de 24 h). Compatible con MySQL 8 y MariaDB; sin ninguna columna de categoría ni de señales de alarma.
- [x] T004 [P] Escribir `tests/integration/urgent-schema.test.ts` (debe fallar antes de aplicar la migración): `calendar_hours.kind` existe con valor por defecto `regular` y rechaza otro valor; `urgent_min_notice_minutes` por defecto 30 y el CHECK rechaza -1 (no unsigned) y 1441; `appointment.kind` acepta `urgent` y rechaza otro; `calendar_action_log.action` acepta `urgent_requested`; **ninguna tabla tiene una columna llamada `category`, `categoria`, `triage` ni `alarm`** (recorrer `information_schema.columns`); la migración es idempotente de aplicar sobre una base ya migrada (la herramienta de migraciones la registra una vez). Ajustar `tests/integration/migrate.test.ts` (lista de migraciones aplicadas hasta `0013`).
- [x] T005 [P] Escribir `tests/unit/triage-content.test.ts` (debe fallar antes de implementar): hay exactamente 5 categorías con `id` en `rojo`, `naranja`, `amarillo`, `verde_claro`, `verde` y `windowHours` 2, 12, 24, 48 y 72 en orden de gravedad; hay exactamente 2 señales de alarma (`dificultad_respirar_tragar`, `hinchazon_ojo`); `parseCategory` y `parseAlarmSignals` aceptan solo esos valores y rechazan cualquier otro; `reviewedByDentist` es `false` y `version` es una cadena no vacía; `urgentContentAvailable(appEnv)` es verdadero en `development` y falso en `production` mientras el contenido sea provisional (y verdadero en producción si se simula `reviewedByDentist = true`); los nombres y textos no están vacíos y ningún texto contiene datos personales ni valores de la configuración.
- [x] T006 Implementar `src/modules/urgent/triage-content.ts` con `TRIAGE_CONTENT` (`version`, `reviewedByDentist = false` con comentario de que solo cambia tras la validación de un dentista y con una nueva versión, categorías con `id`, nombre del semáforo, texto de la opción, `windowHours` y `requiresHospitalNotice`, señales de alarma, textos provisionales de primeros auxilios y del aviso de hospital), esquemas zod (`categorySchema`, `alarmSignalsSchema`), `parseCategory`, `parseAlarmSignals` y `urgentContentAvailable(appEnv, content = TRIAGE_CONTENT)`. T005 debe pasar.
- [x] T007 [P] Escribir pruebas (deben fallar antes de implementar) en `tests/unit/calendar-slots.test.ts` y `tests/unit/availability.test.ts`: `HoursRange` admite `kind` opcional (`regular` por defecto); `generateSlotsForDay(settings, hours, date, kinds)` filtra por tipo (por defecto solo `regular`, igual que hoy), cada espacio lleva su `kind`, y con `['regular','urgent']` devuelve ambos ordenados por inicio; `classifySlots` conserva el `kind`; `listFreeSlots` ofrece **solo** espacios `regular` aunque haya franjas de urgencia (así el calendario convencional del paciente no los ve); el cambio de hora (America/Tijuana) no duplica ni pierde espacios en ninguno de los dos tipos.
- [x] T008 Ampliar `src/lib/calendar-slots.ts` y `src/modules/calendar/availability.ts`: `SlotKind = "regular" | "urgent"`, `HoursRange.kind?`, `SlotTime.kind?`, parámetro `kinds` de `generateSlotsForDay` (por defecto `["regular"]`) y propagación del `kind` por `classifySlots`; `listFreeSlots` pasa solo `regular`. Sin cambiar el comportamiento existente. T007 y las pruebas de la feature 2 deben pasar.
- [x] T009 [P] Escribir `tests/unit/urgent-slot.test.ts` (debe fallar antes de implementar): `findNearestUrgentSlot({settings, hours, appointments, blocks, now, windowHours, minNoticeMinutes})` devuelve el espacio libre más próximo con `inicio >= now + minNoticeMinutes` e `inicio <= now + windowHours` (**bordes inclusivos**: justo en el límite de la anticipación y justo en el fin de la ventana se acepta; un minuto antes del primero o después del segundo, no); a igual inicio gana el espacio `urgent`; si el convencional es más próximo, gana el convencional; ignora espacios ocupados (cita vigente), bloqueados, pasados y fuera de horario; una cita cancelada no ocupa; ventana que cruza la medianoche y varios días; cambio de hora (primavera y otoño, America/Tijuana) sin duplicar ni perder espacios; sin franjas devuelve `null`; con anticipación 0 se acepta el espacio que empieza ahora solo si es posterior a `now` (nunca uno ya empezado); el resultado no incluye datos de pacientes.
- [x] T010 Implementar `src/lib/urgent-slot.ts` con `findNearestUrgentSlot` (pura, sin base de datos) usando `generateSlotsForDay(…, ['regular','urgent'])` y `classifySlots`; recorre desde el día local de `now` hasta el día local del fin de la ventana. T009 debe pasar.
- [x] T011 Ampliar la configuración con el tipo de franja y la anticipación de urgencias y los ayudantes de pruebas: `src/modules/calendar/settings.ts` (`CalendarSettings.urgentMinNoticeMinutes`, `DEFAULT_SETTINGS.urgentMinNoticeMinutes = 30`, `LIMITS.urgentMinNoticeMinutes = { min: 0, max: 1440 }`, `LIMITS.urgentRangesPerDay = 2`), `src/modules/calendar/settings-repository.ts` (`loadSettings` lee `kind` de cada franja y `urgent_min_notice_minutes`; `saveSettings` escribe ambos; las franjas existentes son `regular`) y `src/lib/calendar-slots.ts` (`CalendarSettings` gana el campo). Actualizar `tests/integration/helpers/db.ts` (`createCalendarSettings` acepta `urgentMinNoticeMinutes`; `createCalendarHours` acepta `kind` por franja; `createAppointment` acepta `kind`) y los literales de `CalendarSettings` de las pruebas existentes. Pruebas en `tests/integration/calendar-settings-read.test.ts` y `calendar-settings-write.test.ts`: lectura y escritura de ambas listas y de la anticipación de urgencias, valor por defecto 30 sin configuración guardada, y que guardar reemplaza las franjas de **ambos** tipos en la misma transacción.
- [x] T012 [P] Escribir pruebas (deben fallar antes de implementar) en `tests/integration/appointment-create.test.ts` y `tests/integration/booking-service.test.ts`: `resolveSlot`/`assertSlotBookable` aceptan un parámetro de tipos de espacio; la reserva **convencional** del paciente (`reserveAsPatient`) rechaza un horario que solo existe como franja de urgencia (400, «ese horario no existe en la agenda»); el personal (`createAppointment`) sí puede agendar en un espacio de urgencia libre y la cita queda `regular`; el comportamiento previo de ambos con franjas solo convencionales no cambia.
- [x] T013 Ampliar `resolveSlot` y `assertSlotBookable` de `src/modules/calendar/appointment-service.ts` con `options: { kinds?: readonly SlotKind[] }` (por defecto solo `regular`); `createAppointment` y `describeFreeSlot` del personal pasan `['regular','urgent']`; `reserveAsPatient` usa el valor por defecto. T012 debe pasar sin cambiar las pruebas de la feature 2.
- [x] T014 [P] Escribir pruebas (deben fallar antes de implementar) en `tests/integration/outbox.test.ts` con plantillas de prueba registradas en el registro del test: una plantilla con `sensitiveKeys: ["category"]` elimina esas claves del `payload_ref` en la misma transacción en que la fila pasa a `sent`; también al pasar a `cancelled` (por `shouldSend` falso); al abandonarse (`failed` tras agotar los reintentos) elimina las claves **y** encola la plantilla declarada en `fallbackTemplate` para el mismo destinatario con el payload sin claves sensibles; un reintento intermedio **no** elimina las claves; si el envío falla y la transacción se revierte, las claves siguen presentes; sin `sensitiveKeys` el comportamiento es el de siempre; los eventos de registro técnico del outbox siguen sin incluir el `payload`.
- [x] T015 Ampliar `EmailTemplate` en `src/mail/templates.ts` con `sensitiveKeys?: readonly string[]` y `fallbackTemplate?: string`, y `processOutbox` en `src/mail/outbox.ts` para eliminarlas del `payload_ref` al llegar a `sent`, `cancelled` o `failed` (en este último caso encolando la plantilla de respaldo). T014 debe pasar.
- [x] T016 [P] Escribir `tests/unit/captcha.test.ts` (debe fallar antes de implementar, con `fetch` sustituido): `createTurnstileVerifier({ secret, fetchImpl, timeoutMs })` devuelve `ok` con `success: true`; `invalid` con `success: false` (incluido `timeout-or-duplicate`) y con un token vacío o de más de 2048 caracteres **sin llamar al proveedor**; `unavailable` si `fetch` lanza, si pasa el tiempo de espera de 5 s, si responde un estado distinto de 200 o un cuerpo que no es JSON válido o sin `success` booleano; envía `secret`, `response` y `remoteip` (nunca nada más: ni categoría ni datos del paciente) y no reintenta; el secreto y el token nunca aparecen en lo que se registra ni en los mensajes de error; `createDisabledVerifier` (desarrollo sin claves) devuelve siempre `ok`.
- [x] T017 Implementar `src/modules/urgent/captcha.ts` (`CaptchaVerifier` con `verify(token, ip): Promise<"ok" | "invalid" | "unavailable">`, `createTurnstileVerifier`, `createDisabledVerifier`) y cablearlo en `src/compose.ts`: `Services.captcha` (verificador de Turnstile si hay claves; el desactivado si `APP_ENV=development` sin claves; en producción sin claves, un verificador que siempre responde `unavailable`) y `Services.captchaSiteKey` para el widget; `composeApp` acepta un `captcha` inyectable para pruebas (en producción sin claves, `captcha` responde `unavailable` solo como red de seguridad: ofrecer o no el flujo lo decide únicamente `urgentAvailability` de T046); `tests/integration/helpers/app.ts` (`createTestApp` acepta `captcha` y por defecto usa un verificador falso `ok`). T016 debe pasar.
- [x] T018 [P] Ampliar `src/modules/calendar/action-log.ts` (`CalendarAction` gana `urgent_requested`) y `src/modules/calendar/appointment-repository.ts` (`insertAppointment` acepta `kind` con valor por defecto `regular`; `AppointmentRecord.kind`; todas las lecturas lo devuelven; `listBookedSpansInRange` no cambia) con pruebas en `tests/integration/appointment-create.test.ts` y `calendar-isolation.test.ts`: una cita `urgent` se guarda con `kind = 'urgent'`, el resto sigue `regular`, y ninguna lectura de otro médico la devuelve.

**Checkpoint**: la base permite guardar franjas y citas de urgencia, buscar el espacio más próximo y enviar un correo con claves que se borran; ninguna historia empezó.

---

## Phase 3: User Story 1 - El paciente pide una cita de urgencia y se le asigna el espacio más próximo (Priority: P1)

**Goal**: un paciente con sesión elige una categoría y el servidor agenda el espacio libre más próximo dentro de la ventana de su nivel, sin calendario y sin doble reserva.

**Independent Test**: con un médico con micrositio publicado y franjas de urgencia, un paciente pide una urgencia de cada nivel y recibe el espacio más próximo dentro de su ventana; la cita queda marcada como urgencia en la agenda y nunca se asigna un espacio ocupado.

### Tests for User Story 1

- [x] T019 [P] [US1] Escribir `tests/integration/urgent-service.test.ts` (debe fallar antes de implementar): `requestUrgent(ctx, deps, { patientId, category, authorize })` asigna el espacio libre más próximo dentro de la ventana de cada una de las 5 categorías y con la anticipación de urgencias del médico (30 min por defecto, configurable); inserta la cita con `kind = 'urgent'`, `created_by_role = 'patient'` y `created_by_user_id` del paciente; crea o reutiliza el vínculo con `origin = 'patient'` y registra la autorización de datos (casilla obligatoria si no hay una activa: `ValidationError` con el campo `autorizo`, sin cita ni vínculo); la cita de un menor queda a su nombre con la autorización del tutor; rechaza por conflicto el espacio que se ocupó y devuelve el siguiente; nunca asigna espacios ocupados, bloqueados, pasados ni fuera del horario ni desplaza citas; con un espacio de urgencia y uno convencional a la misma hora gana el de urgencia; consultorio despublicado o médico no aprobado: `SiteUnavailableError` (403) sin cita; paciente de otra cuenta o inexistente: `NotFoundError` sin cita; la fila de `calendar_action_log` es `urgent_requested` con `outcome = 'ok'` y el `appointment_id`; **ninguna tabla guarda la categoría** (consultar la cita, el vínculo, la autorización y el registro de acciones); la categoría inválida se rechaza antes de tocar la base.
- [x] T020 [P] [US1] Escribir `tests/integration/urgent-concurrency.test.ts` (**obligatoria por la constitución**; debe fallar antes de implementar): 20 solicitudes simultáneas de pacientes distintos con **un solo** espacio libre dentro de la ventana → exactamente una cita vigente y las otras 19 devuelven «sin espacio»; con dos espacios libres, dos citas y 18 sin espacio; urgencia contra un bloqueo del médico sobre el único espacio (20 rondas): nunca una cita dentro de un bloqueo; urgencia contra una reserva convencional del paciente sobre el mismo espacio (10 rondas): una gana y la otra recibe conflicto o el siguiente espacio, nunca dos citas; urgencia contra la cancelación (por el personal) de una cita que libera el único espacio (10 rondas): a lo sumo una cita vigente y sin pérdidas; el mismo paciente enviando 20 veces a la vez: una sola cita.
- [x] T021 [P] [US1] Escribir `tests/contract/urgent-request.test.ts` (debe fallar antes de implementar): `GET /c/:slug/urgencia` (sin sesión 303 a `/c/:slug`; con sesión HTML con el formulario: las dos casillas de señales **sin marcar**, 5 categorías en radio **sin valor por defecto**, selector de paciente y casilla de autorización si hace falta; sin ningún horario ni calendario; JSON sin horarios), `POST /c/:slug/urgencia` (303 a `/pacientes/citas/:id` con espacio; 400 con categoría o paciente inválidos y el cuerpo de la respuesta **no repite la categoría recibida**; 400 sin la casilla de autorización; 404 con paciente de otra cuenta; 403 con micrositio despublicado; sin token CSRF 403; el médico sale del `slug` y un `doctorId` del cuerpo se ignora; el personal con sesión recibe 403); la respuesta, la URL de redirección y las cookies no contienen la categoría; `GET /agenda/citas/:id` y la agenda del médico muestran `kind` urgencia (se completa en US3).

### Implementation for User Story 1

- [x] T022 [US1] Implementar `src/modules/urgent/urgent-service.ts` → `requestUrgent(ctx, deps, input)` bajo `withCalendarLock` con el orden de `research.md` (decisión 5), sin límites ni correos todavía (llegan en US4 y US5): consultorio acepta reservas (`isAcceptingBookings`) → paciente de la cuenta (`findPatientOfAccount`) → autorización de datos (`hasActiveAuthorization`) → lectura **única** de citas y bloqueos del rango de la ventana (`listBookedSpansInRange` y `listBlockSpansInRange`) y `findNearestUrgentSlot` → revalidación con `assertSlotBookable(ctx, connection, startLocal, now, { kinds: ['regular', 'urgent'] })` dentro de la misma transacción (el inicio hallado se convierte a hora local `AAAA-MM-DDTHH:MM` con `formatLocalInstant`; sin pasar `kinds`, un espacio de una franja de urgencia se rechazaría como «el horario no existe») → vínculo con `origin: 'patient'` y `recordAuthorization` si hacía falta → `insertAppointment({ kind: 'urgent' })` con traducción del error 1062 a «espacio no disponible» (reintentar con el siguiente espacio, máximo 3 intentos) → `logCalendarAction('urgent_requested', 'ok')`. Devuelve `{ kind: 'scheduled', id, startUtc, endUtc }` o `{ kind: 'no_space' }` (este último se completa en US2). La categoría solo se usa para elegir la ventana: no se escribe en ninguna parte. T019 y T020 deben pasar.
- [x] T023 [US1] Implementar `src/http/views/urgent.ts` (formulario con las señales y las categorías con su color de semáforo y texto, selector de paciente, casilla de autorización, widget de Turnstile con la `siteKey` y sin JavaScript propio; pantalla de resultado) y `src/modules/urgent/routes.ts` con `GET` y `POST /c/:slug/urgencia` (CSRF, `resolvePatientSite` para el contexto, esquema zod de `categoria`, `patientId`, `senales`, `autorizo` y `cf-turnstile-response`, redirección 303 a `/pacientes/citas/:id`, sin repetir la categoría en errores); registrarlo en `src/compose.ts` y añadir en `src/http/views/site.ts` el enlace «Tengo una urgencia» a la pantalla de reserva del paciente (`bookingPage`). T021 debe pasar.

**Checkpoint**: US1 funcional sin límites ni correos: un paciente pide una urgencia y obtiene su espacio sin doble reserva.

---

## Phase 4: User Story 2 - Sin espacio y señales de alarma (Priority: P1)

**Goal**: cuando no hay espacio, o cuando el paciente marca una señal de alarma, ve cómo comunicarse con el médico y el aviso de hospital, sin cita ni aviso, y sin dejar rastro de la señal.

**Independent Test**: con un consultorio sin espacios, pedir una urgencia de nivel alto y comprobar el móvil de emergencias y el aviso de hospital; marcar una señal de alarma y comprobar que no se verifica el CAPTCHA, no se registra nada y no cuenta para el límite.

### Tests for User Story 2

- [x] T024 [P] [US2] Escribir `tests/integration/urgent-no-space.test.ts` (debe fallar antes de implementar): sin ningún espacio libre en la ventana, `requestUrgent` devuelve `{ kind: 'no_space' }`, **no** crea cita, vínculo ni autorización nueva… salvo que ya existiera, **no** encola ningún correo y deja `urgent_requested` con `outcome = 'rejected'` (una fila, sin `appointment_id`, sin categoría); con espacios convencionales libres pero sin franjas de urgencia usa el convencional más próximo; un espacio libre **después** de la ventana no se asigna; el resultado `no_space` confirma la transacción (la fila queda aunque no haya cita); la solicitud sin espacio cuenta como solicitud (se verifica en US4).
- [x] T025 [P] [US2] Escribir `tests/contract/urgent-emergency.test.ts` (debe fallar antes de implementar): `POST` sin espacio responde 200 con «No encontramos espacio», el móvil de emergencias del médico con formato de 10 dígitos y, en los niveles con `requiresHospitalNotice`, el aviso de hospital; si el médico no tiene móvil se muestra el teléfono del consultorio; **señales de alarma**: con `dificultad_respirar_tragar` o `hinchazon_ojo` (una o ambas) responde 200 con la pantalla de emergencia (aviso de hospital y móvil de emergencias) **sin llamar al verificador de CAPTCHA, sin llamar a `requestUrgent`, sin crear cita, sin fila en `calendar_action_log`, sin correo y sin contar** (comprobar con el verificador falso y con consultas a la base); la respuesta no repite la categoría; una señal inválida da 400; el móvil de emergencias aparece solo a pacientes con sesión y **no** en `GET /c/:slug` ni en `GET /c/:slug/entrar`; la pantalla de emergencia no se cachea (`cache-control: no-store`).

### Implementation for User Story 2

- [x] T026 [US2] En `src/modules/urgent/urgent-service.ts` devolver `no_space` registrando `urgent_requested` con `outcome = 'rejected'` y **confirmando** la transacción (sin lanzar excepción); implementar en `src/http/views/urgent.ts` las pantallas «sin espacio» y «emergencia» con el aviso de hospital según el nivel y el helper `emergencyContact(doctor)` que devuelve el móvil de emergencias o el teléfono del consultorio (formato `55 1234 5678`), y en `src/modules/urgent/routes.ts` el manejo de señales de alarma **antes** del CAPTCHA y del servicio (nada se guarda ni se cuenta), con `cache-control: no-store`. T024 y T025 deben pasar.

**Checkpoint**: US1 + US2: la solicitud siempre termina en una cita, en «sin espacio» o en la pantalla de emergencia.

---

## Phase 5: User Story 3 - El médico configura sus horarios de urgencia (Priority: P1)

**Goal**: el médico define franjas de urgencia y su anticipación mínima desde la agenda; esas franjas no aparecen en el calendario convencional y la agenda las muestra con su etiqueta.

**Independent Test**: configurar franjas y anticipación, comprobar que el calendario convencional del paciente no las ofrece, que una urgencia sí las usa y que la agenda marca «Urgencia».

### Tests for User Story 3

- [x] T027 [P] [US3] Escribir `tests/unit/calendar-settings.test.ts` (ampliar; debe fallar antes de implementar): el formulario acepta `u<día 1-7>_<franja 0-1>_start` y `_end` (`HH:MM` múltiplos de 5, `24:00` solo como fin, ambos vacíos = sin franja) y `urgentMinNoticeMinutes` (entero 0–1440; 30 si no se envía); hasta **2** franjas de urgencia por día (la tercera no existe en el formulario); fin > inicio; sin solape con **ninguna** franja del mismo día (ni convencional ni de urgencia: error con clave `u<día>_<franja>` y mensaje claro); no cruza la medianoche; valores fuera de rango, notación científica, negativos y decimales rechazados; los errores existentes de las franjas convencionales no cambian de clave.
- [x] T028 [P] [US3] Escribir `tests/contract/calendar-settings.test.ts` (ampliar) y `tests/integration/urgent-hours.test.ts` (debe fallar antes de implementar): `GET /agenda/configuracion` (JSON con `hours: [{ weekday, start, end, kind }]` y `settings.urgentMinNoticeMinutes`; HTML con el bloque de urgencias; 403 a recepción), `POST /agenda/configuracion` (guarda ambas listas y la anticipación en una transacción; solape entre urgencia y convencional → 400 sin guardar nada; recepción 403; sin CSRF 403; cambiar franjas **no modifica** las citas existentes); el calendario convencional del paciente (`getMonthView` y `getDayView` de `availability-view.ts` y la ruta `GET /c/:slug/reservar`) no ofrece los espacios de urgencia; una cita convencional nunca cae en una franja de urgencia; la agenda del día y de la semana (`GET /agenda/dia/:fecha`) marca los espacios de urgencia como «Urgencia» y las citas `urgent` con la etiqueta, y **no** las lista como «fuera del horario actual»; el detalle de la cita (`GET /agenda/citas/:id`, HTML y JSON) muestra el tipo (`kind`); el personal agenda en un espacio de urgencia y la cita queda `regular`; la anticipación mínima de urgencias de 30 min por defecto se respeta en la asignación (ya cubierta en T019).

### Implementation for User Story 3

- [x] T029 [US3] Ampliar `src/modules/calendar/settings.ts` con el esquema zod de las franjas de urgencia y de `urgentMinNoticeMinutes` y la validación de no solape contra todas las franjas del día (usar `LIMITS.urgentMinNoticeMinutes` y `LIMITS.urgentRangesPerDay`), `src/modules/calendar/routes.ts` (JSON y formulario con `kind`, 403 a recepción) y `src/http/views/calendar.ts` (bloque «Horario de urgencias» y campo de anticipación). T027 y la parte de configuración de T028 deben pasar.
- [x] T030 [US3] Ampliar `src/modules/calendar/agenda-service.ts` (el día y la semana usan `generateSlotsForDay(…, ['regular','urgent'])`, cada espacio y cada cita llevan `kind`; las citas `urgent` dentro de franjas de urgencia no cuentan como fuera de horario) y `src/http/views/calendar.ts` + `src/modules/calendar/routes.ts` (etiqueta «Urgencia» en espacios de urgencia y en citas `urgent`; «Tipo» en el detalle, `kind` en JSON). El resto de T028 debe pasar.

**Checkpoint**: US1–US3: el médico controla cuánto de su día reserva a urgencias y la agenda las distingue.

---

## Phase 6: User Story 4 - Protecciones contra abuso y límites (Priority: P1)

**Goal**: una urgencia activa por paciente, 3 solicitudes por cuenta cada 24 h, CAPTCHA y límites por IP; las urgencias no consumen los cupos de reserva convencional.

**Independent Test**: hacer solicitudes hasta rebasar cada límite y comprobar que se rechazan sin crear citas ni avisos; probar el CAPTCHA inválido y no disponible.

### Tests for User Story 4

- [x] T031 [P] [US4] Escribir `tests/integration/urgent-limits.test.ts` (debe fallar antes de implementar): una urgencia vigente (agendada que aún no empieza) impide otra del **mismo paciente** (`ConflictError` con código `urgent_active`) y no impide la de otro paciente de la cuenta ni una urgencia ya empezada o cancelada; 3 solicitudes por cuenta en 24 h (**contando las que terminaron sin espacio**; una cuarta lanza `TooManyAttemptsError` con la espera calculada desde la más antigua; pasadas 24 h se permite; el borde de 24 h es exacto); las solicitudes rechazadas por validación, alarma, CAPTCHA, límite o paciente ajeno **no** dejan fila ni cuentan; doble envío (urgencia vigente de la misma cuenta y paciente creada hace menos de 2 minutos) devuelve esa cita con `created: false` sin segunda cita ni segunda fila de solicitud; **una ráfaga simultánea de 5 solicitudes de la misma cuenta deja pasar exactamente 3**; las urgencias **no** consumen las 5 reservas por hora ni las 3 citas vigentes por paciente de la reserva convencional, y las reservas convencionales no consumen los cupos de urgencia; el límite se cuenta por cuenta entre consultorios.
- [x] T032 [P] [US4] Escribir `tests/contract/urgent-protections.test.ts` (debe fallar antes de implementar): CAPTCHA inválido → 400 `captcha_invalid` sin buscar espacio ni contar; CAPTCHA no disponible → 200 con el móvil de emergencias y el teléfono del consultorio, sin cita ni fila de solicitud (**falla cerrado**); token ausente o de más de 2048 caracteres → 400; en desarrollo sin claves el paso se omite; límite por IP (la 11.ª solicitud en una hora desde la misma IP recibe 429 con `Retry-After`, y `GET` 120/min); 409 `urgent_active`; 429 `Retry-After` por las 3 solicitudes en 24 h; el doble envío del formulario da 303 a la misma cita; el verificador recibe solo el token y la IP (comprobar con el verificador falso).

### Implementation for User Story 4

- [x] T033 [US4] Implementar `src/modules/urgent/urgent-limits.ts` (`assertWithinUrgentLimits(ctx, executor, now, { userId, patientId })` y `findRecentUrgent(ctx, executor, userId, patientId, now)` para el doble envío; el conteo de 24 h sale de `calendar_action_log` filtrando `urgent_requested` por `actor_user_id`; la urgencia activa de `appointment` con `kind = 'urgent'`, `status = 'booked'` y `start_utc > now` del paciente) y llamarlo en `requestUrgent` en el orden de `research.md` (doble envío → una activa → 3 por 24 h, antes de la autorización y la búsqueda); `src/modules/site/booking-service.ts` y `src/modules/site/patient-appointments.ts` filtran `kind = 'regular'` en el conteo de 5 reservas por hora y de 3 citas vigentes (las urgencias no cuentan); `src/jobs/reminders-service.ts` solo encola recordatorios para citas `kind = 'regular'` (una urgencia no recibe recordatorio ni «plazo para cancelar»), con un caso nuevo en `tests/integration/reminders.test.ts` escrito antes del cambio (una urgencia que ya cumple el momento del recordatorio no genera fila). T031 debe pasar.
- [x] T034 [US4] En `src/modules/urgent/routes.ts` verificar el CAPTCHA con `Services.captcha` **después** de las señales de alarma y **antes** de `requestUrgent` (inválido → 400 `captcha_invalid`; no disponible → pantalla con móvil de emergencias y teléfono del consultorio; ninguno cuenta), límites de tasa por IP (`POST` 10 por hora, `GET` 120 por minuto), CSP ampliada solo en esta ruta (`script-src` y `frame-src https://challenges.cloudflare.com`, con prueba de que no se añade en las demás rutas) y conversión de `TooManyAttemptsError` en 429 con `Retry-After`. T032 debe pasar.

**Checkpoint**: US1–US4: la urgencia está protegida contra abuso y el flujo falla cerrado si el CAPTCHA no está disponible.

---

## Phase 7: User Story 5 - El médico recibe el aviso de urgencia sin datos del paciente (Priority: P1)

**Goal**: el paciente recibe su confirmación y el médico un aviso con la categoría, que solo vive en la cola de envío y se borra al entregarse, cancelarse, abandonarse o a las 24 h.

**Independent Test**: agendar urgencias de cada categoría; revisar el correo al médico, que la categoría desaparece de la cola en cada estado final y que ninguna tabla ni registro la conserva.

### Tests for User Story 5

- [x] T035 [P] [US5] Escribir `tests/integration/urgent-emails.test.ts` (debe fallar antes de implementar): al agendar, el paciente (o el tutor, si es menor) recibe `appointment_created` con día y hora en la zona del consultorio, dirección, teléfono, enlace `/citas/enlace/<token>`, el médico como `Reply-To`, texto de «cita de urgencia» y **sin la categoría ni el nivel**; el médico recibe `doctor_urgent_notice` **en el correo de su cuenta (no recepción)** con el nombre del semáforo, día y hora, enlace `/agenda/dia/<fecha>`, **sin nombre del paciente, correo ni teléfono**; los asuntos no llevan datos personales; el outbox guarda `{ appointmentId, category }` solo en la fila del aviso al médico y `{ appointmentId }` en la del paciente; se encolan en la misma transacción que la cita (si la transacción falla no queda ninguno); `doctor_urgent_notice` con `shouldSend` sobre la cita: si se cancela antes del envío no sale y la fila queda `cancelled` sin categoría; un correo que falla no deshace la cita; una solicitud sin espacio no encola nada; el aviso **no se bloquea por cuota** (con cuota agotada simulada sale igual); el aviso al médico sale en **una sola ejecución** de `processOutbox` tras agendar (reloj controlado: el siguiente ciclo del cron), que es lo que respalda SC-003 en pruebas.
- [x] T036 [P] [US5] Escribir `tests/integration/urgent-category-lifecycle.test.ts` (debe fallar antes de implementar): tras entregarse `doctor_urgent_notice`, `payload_ref` ya no contiene `category`; al cancelarse la cita antes del envío, la fila `cancelled` no contiene `category`; si el envío falla hasta agotar los reintentos, la fila `failed` no contiene `category` y se encoló `doctor_urgent_generic` («Tienes una urgencia agendada») sin categoría, con `Reply-To` ausente y al correo del médico; una fila en cola con más de 24 h (reloj controlado) pasa por `expireUrgentCategories(db, clock)` → se convierte en `doctor_urgent_generic` sin categoría y sale en el siguiente ciclo; correr el job varias veces o con dos procesos a la vez no duplica avisos ni deja categorías; una fila con menos de 24 h no se toca; la categoría de una fila en cola de 23 h 59 min sigue presente (borde); el job `jobs:outbox` llama a `expireUrgentCategories` antes de `processOutbox` y tolera que no haya filas.
- [x] T037 [P] [US5] Escribir `tests/integration/urgent-privacy.test.ts` (debe fallar antes de implementar): tras recorrer los flujos (urgencia agendada de cada categoría, sin espacio, alarma, CAPTCHA inválido y no disponible, cancelación, aviso entregado, abandonado y expirado) **ninguna tabla de la base** (recorriendo `information_schema.tables` y sus columnas de texto/JSON con un `SELECT` por columna) contiene los identificadores de categoría (`rojo`, `naranja`, `amarillo`, `verde_claro`, `verde`) ni los de señales de alarma como valor de `category`, `categoria`, `senales`, ni dentro de un JSON de `payload_ref` **salvo** las filas `doctor_urgent_notice` en cola; los registros técnicos capturados con `logStream` (peticiones, errores de validación, errores del outbox, fallos del verificador) no contienen la categoría, las señales, el token del CAPTCHA, el correo ni el nombre del paciente; el cuerpo de los correos al paciente y al médico tras el borrado no la contiene; la salida JSON de las rutas tampoco.

### Implementation for User Story 5

- [x] T038 [US5] Implementar `src/modules/urgent/email-templates.ts` con `doctor_urgent_notice` (`sensitiveKeys: ["category"]`, `fallbackTemplate: "doctor_urgent_generic"`, `shouldSend` con `FOR UPDATE` sobre la cita, asunto «Nueva urgencia agendada», nombre del semáforo en lugar del identificador) y `doctor_urgent_generic` (asunto «Tienes una urgencia agendada»); registrar ambas en `src/mail/templates.ts`; ampliar `appointment_created` en `src/modules/calendar/email-templates.ts` con el texto de «cita de urgencia» cuando la cita es `urgent` (cargar `kind` en `loadFacts`) y sin categoría; encolar en `requestUrgent` (misma transacción que la cita) `appointment_created` al correo de la cuenta del paciente (`findNotificationEmailForDoctor`) y `doctor_urgent_notice` al correo de la cuenta del médico (`findDoctorAccountEmail`, nunca recepción) con `payload { appointmentId, category }`. T035 debe pasar.
- [x] T039 [US5] Implementar `src/jobs/urgent-notices.ts` (`expireUrgentCategories(db, clock)`: selecciona hasta 200 filas `doctor_urgent_notice` con `status = 'queued'` y más de 24 h, y en transacción con actualización condicional convierte cada una en `doctor_urgent_generic` con el payload sin `category`; idempotente) y llamarlo al inicio de `src/jobs/outbox.ts` antes de `processOutbox` (con reloj del sistema). T036 debe pasar.
- [x] T040 [US5] Revisar con T037 todos los puntos por donde pasa la categoría y corregir lo que filtre (mensajes de error de zod, `fastify` request logging, `sendError`, `request.body` en errores, eventos del outbox, `console` y trazas): sustituir cualquier cadena que incluya el valor recibido por mensajes fijos; añadir al redactor del registrador (`src/http/logger.ts`) las claves `categoria`, `category`, `senales` y `cf-turnstile-response` como redactadas por si algún día se registra el cuerpo. T037 debe pasar.

**Checkpoint**: US1–US5: el piloto puede recibir urgencias con aviso al médico y la categoría efímera.

---

## Phase 8: User Story 6 - El paciente cancela su urgencia cuando quiera (Priority: P2)

**Goal**: el paciente cancela su urgencia en cualquier momento antes de que empiece, sin el plazo de 24 h; el médico recibe el aviso.

**Independent Test**: agendar una urgencia para dentro de 40 minutos y cancelarla: se permite, libera el espacio y avisa al médico.

### Tests for User Story 6

- [x] T041 [P] [US6] Escribir `tests/integration/urgent-cancel.test.ts` (debe fallar antes de implementar): `cancelAsPatient` cancela una cita `urgent` que empieza en menos de 24 h (y justo antes de empezar) sin `cancellation_window_closed`; una cita **convencional** en el mismo caso sigue rechazándose; una urgencia ya iniciada o pasada o ya cancelada da conflicto sin repetir avisos; el espacio queda libre de inmediato (otra urgencia o reserva lo toma); el tope de 10 cancelaciones por hora por cuenta sigue aplicando a las urgencias; el médico recibe `doctor_appointment_cancelled` (nombre, fecha y hora, **sin categoría**) y el paciente `appointment_cancelled_by_patient`; la cancelación registra quién y cuándo; tras cancelar, el paciente puede pedir otra urgencia dentro de sus límites (la cancelada ya no es «activa» pero cuenta en las 3 de 24 h); si el aviso original `doctor_urgent_notice` seguía en cola, queda `cancelled` sin categoría (con T038).
- [x] T042 [P] [US6] Escribir `tests/contract/urgent-cancel.test.ts` (debe fallar antes de implementar): `POST /pacientes/citas/:id/cancelar` y `POST /citas/enlace/:token/cancelar` cancelan una urgencia dentro de las 24 h (303) y siguen respondiendo 409 para una convencional dentro del plazo; `GET /pacientes/citas` y `GET /pacientes/citas/:id` muestran la etiqueta «Urgencia» y el botón de cancelar mientras no haya empezado; el enlace del correo de confirmación de una urgencia sigue las reglas de la feature 3 (abrirlo no cambia nada; cancelar exige sesión y CSRF y consume el token); otra cuenta recibe 404 o el 410 genérico.

### Implementation for User Story 6

- [x] T043 [US6] En `src/modules/site/account-appointments.ts` (`PatientAppointmentRow.kind`, `SELECT_FOR_PATIENT` incluye `a.kind`), `src/modules/site/patient-appointments.ts` (`cancelAsPatient` omite el plazo cuando `kind = 'urgent'` y conserva el tope por hora; `PatientAppointmentItem.kind` y `cancelable` = vigente para urgencias), `src/modules/site/appointment-links.ts` (`cancelable` de las urgencias) y `src/http/views/site.ts` (etiqueta «Urgencia» en «Mis citas» y en el detalle; sin el texto de «ya pasó el plazo» para urgencias). T041 y T042 deben pasar sin cambiar las pruebas de la feature 3.

**Checkpoint**: US1–US6: ciclo completo de la urgencia, incluida su cancelación.

---

## Phase 9: User Story 7 - Micrositio sin servicio y contenido provisional (Priority: P2)

**Goal**: sin servicio en línea, o con contenido médico provisional en producción, no se ofrece la urgencia y se dirige a llamar al consultorio.

**Independent Test**: despublicar el micrositio y comprobar que no se puede pedir una urgencia; en producción con contenido provisional, comprobar que el flujo queda bloqueado con el teléfono del consultorio.

### Tests for User Story 7

- [x] T044 [P] [US7] Escribir `tests/contract/urgent-availability.test.ts` (debe fallar antes de implementar): con micrositio despublicado o médico no aprobado, `GET` y `POST /c/:slug/urgencia` responden la pantalla «confirma directamente con el consultorio por teléfono» con el teléfono (403 en el `POST`) y no se asigna espacio ni se llama al verificador; con `APP_ENV=production` y contenido provisional (`reviewedByDentist = false`), `GET` muestra «llama al consultorio» con el teléfono y **sin** los textos del triaje, y `POST` responde 403 sin buscar espacio; con `reviewedByDentist = true` simulado se ofrece; con `APP_ENV=production` sin claves del CAPTCHA, el flujo no se ofrece (teléfono del consultorio); en `development` se ofrece; el enlace «Tengo una urgencia» de la pantalla de reserva solo aparece cuando el flujo está disponible; la pantalla de «no disponible» no revela el móvil de emergencias; la versión del contenido (`version`) se muestra en el formulario.
- [x] T045 [P] [US7] Escribir `tests/integration/urgent-readonly.test.ts` (debe fallar antes de implementar): `requestUrgent` con el consultorio sin servicio lanza `SiteUnavailableError` **dentro** de la transacción aunque la ruta ya lo haya comprobado (revalidación bajo el bloqueo); despublicar entre la lectura de la pantalla y el `POST` produce el mismo rechazo; ninguna cita, vínculo ni fila de solicitud queda.

### Implementation for User Story 7

- [x] T046 [US7] Implementar `urgentAvailability(services, site)` en `src/modules/urgent/routes.ts` (devuelve `available` o el motivo: `site_unavailable`, `content_provisional`, `captcha_unconfigured`) usando `urgentContentAvailable(appEnv)`, `services.captchaSiteKey` y el estado del micrositio; aplicarlo en `GET` y `POST` y en `bookingPage` (`src/http/views/site.ts`) para mostrar u ocultar el enlace; mostrar `TRIAGE_CONTENT.version` en el formulario. T044 y T045 deben pasar.

**Checkpoint**: todas las historias completas y probadas por separado.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [x] T047 [P] Escribir `tests/integration/urgent-isolation.test.ts`: un paciente no ve ni cancela urgencias de otra cuenta (404 con ids ajenos); el personal (médico y recepción) y soporte con sesión reciben 403 en `/c/:slug/urgencia`; un `doctorId` o `patientId` manipulado no cambia a quién se agenda; un médico no ve urgencias de otro; el micrositio y sus rutas públicas no devuelven datos de pacientes ni el móvil de emergencias; recorrer las funciones exportadas de `src/modules/urgent/` y comprobar que las que tocan datos de un médico reciben el contexto como primer parámetro (lista de excepciones justificadas, como en `site-isolation.test.ts`).
- [x] T048 Ampliar `tests/integration/route-audit.test.ts`: leer también `specs/004-urgencias-y-triaje/contracts/http-routes.md`; añadir a `PUBLIC_GET` `/c/:slug/urgencia` (redirige 303 sin sesión); verificar que todo `POST` sin CSRF responde 403 (incluida la ruta nueva) y que ningún `GET` de `/c/` cambia estado (comparar la base antes y después de recorrerlos, ahora con franjas de urgencia y una urgencia agendada); extender la comprobación del primer parámetro a `src/modules/urgent/*.ts`.
- [x] T049 [P] Documentar: `docs/decisions/0005-urgencias.md` (decisiones de `research.md`, tabla de ventanas provisional, límites, riesgos abiertos: dependencia del CAPTCHA de un tercero, contenido médico pendiente de dentista, móvil de emergencias sin verificación por WhatsApp, límite por cuenta entre médicos, límite por IP en memoria, límites exactos por consultorio y blandos entre consultorios, y que SC-008 solo mide «agendada» frente a «sin espacio» porque las señales de alarma y el CAPTCHA no disponible no se registran por diseño), actualizar `docs/configuration.md` (sección de urgencias: migración `0013`, claves de Turnstile con claves de prueba, el cron de `jobs:outbox` ahora también expira categorías, humo de despliegue: entrega del aviso al médico en menos de 3 minutos con el cron real, borrado de la categoría y aviso genérico) y notas de cambio en `specs/002-calendario-del-medico/contracts/http-routes.md` y `docs/decisions/0003-calendario.md` (horarios de urgencia, `kind`, etiqueta en la agenda).
- [x] T050 Ejecutar el conjunto completo de pruebas (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) por PowerShell con ruta `C:\…` en segundo plano mediante un archivo `.ps1`, sin editar código mientras corre; corregir fallos; comprobar los escenarios 1–43 de `quickstart.md` y la ausencia de `console.log` y de `any` sin justificar.
- [ ] T051 Revisión independiente antes de dar la feature por terminada: `code-review` y `/security-review` sobre el diff de la feature (con atención a la invariante de no doble reserva de las urgencias, a que la categoría y la señal de alarma no se persistan en ninguna parte, al borrado de la categoría en todos los estados finales, a que el CAPTCHA falle cerrado y no filtre datos, al aislamiento y a la CSP ampliada), verificando cada hallazgo antes de aplicarlo; documentar el resultado y corregir.
- [ ] T052 Recorrido manual en navegador con SMTP real y el widget de Turnstile con claves reales (configurar franjas de urgencia → pedir una urgencia de cada nivel → marcar una señal de alarma → ver sin espacio → cancelar → ver los correos) y, en el despliegue de pruebas de Hostinger, comprobar la migración `0013` en MariaDB, repetir los escenarios de concurrencia (26–30), medir la entrega del aviso al médico con el cron por minuto (menos de 3 minutos en el 98 %), comprobar el borrado de la categoría y el aviso genérico, y validar el contenido del triaje con un dentista antes de cambiar `reviewedByDentist`. Medir en el piloto SC-008 (urgencias con espacio frente a «llama al médico»). **Requiere a una persona**; dejar anotado el estado igual que T062 de la feature 2 y T071 de la feature 3.
- [x] T053 Verificar que `spec.md` refleja lo implementado (FR y supuestos), actualizar los contratos y `checklists/requirements.md` si algo cambió, y marcar las tareas hechas.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; **bloquea todas las historias**. Orden interno: T003 → T004; T005 → T006; T007 → T008; T009 → T010 (necesita T008); T011 (necesita T003 y T008); T012 → T013 (necesita T008 y T011); T014 → T015; T016 → T017 (necesita T002); T018 (necesita T003 y T011).
- **US1 (Phase 3)**: depende de la Fase 2. Es el MVP: sin ella no hay urgencias.
- **US2 (Phase 4)**: depende de US1 (misma ruta y servicio).
- **US3 (Phase 5)**: depende de la Fase 2 y de T011; puede ir en paralelo con US1/US2 (usa helpers para crear franjas en las pruebas de US1) pero se recomienda tras US2 para que la agenda ya tenga citas de urgencia que mostrar.
- **US4 (Phase 6)**: depende de US1 y de T017 (CAPTCHA).
- **US5 (Phase 7)**: depende de US1 y de T015 (outbox con claves sensibles); T040 depende de US1 a US4.
- **US6 (Phase 8)**: depende de US1 y de US5 (el aviso en cola se cancela con la cita).
- **US7 (Phase 9)**: depende de US1 y de US4 (CAPTCHA) y de T006.
- **Polish (Phase 10)**: depende de todas las historias.

### Within Each User Story

- Pruebas primero y **deben fallar** antes de implementar la regla de negocio.
- Función pura → repositorio → servicio → vistas → rutas.
- Cada historia termina con su punto de control y un commit antes de pasar a la siguiente.

### Parallel Opportunities

- Fase 2: T002, T004, T005, T007, T009, T012, T014, T016 y T018 son paralelizables entre sí tras sus dependencias.
- Dentro de cada historia, las pruebas marcadas [P] (archivos distintos) pueden escribirse en paralelo.
- `src/modules/urgent/routes.ts`, `src/http/views/urgent.ts`, `src/modules/urgent/urgent-service.ts` y `src/http/views/site.ts` los tocan varias historias: aplicar esas tareas de una en una.
- No se debe ejecutar la suite de base de datos de forma concurrente en varios procesos.

---

## Implementation Strategy

### MVP First (US1 → US2 → US3 → US4)

1. Fase 1 y Fase 2 completas.
2. US1: el paciente pide una urgencia y obtiene su espacio.
3. US2: sin espacio y señales de alarma (el camino de seguridad).
4. US3: el médico configura sus horarios de urgencia.
5. US4: protecciones contra abuso (no se abre el flujo al piloto sin ellas).
6. **Detenerse y validar**: de punta a punta sin correos todavía; luego US5 para el aviso al médico.

### Incremental Delivery

1. Base + US1 → urgencias asignadas.
2. US2 → camino de seguridad.
3. US3 → el médico controla el cupo.
4. US4 → protegido contra abuso.
5. US5 → avisos con la categoría efímera.
6. US6 y US7 → cancelación y bloqueos por disponibilidad y contenido.
7. Polish → aislamiento, auditoría de rutas, documentación, revisiones y recorrido manual.

### Notas

- WhatsApp (avisos por WhatsApp y cuotas por plan), cobro con Openpay, panel de soporte completo, historial clínico y reprogramación quedan fuera.
- Esta feature cambia comportamiento de las features 2 y 3 en estos puntos: T011 y T013 (franjas con tipo y espacios por tipo), T018 (`insertAppointment` con tipo), T015 (outbox con claves sensibles), T033 (límites de reserva sin urgencias), T038 (texto de `appointment_created`) y T043 (cancelación sin plazo para urgencias): sus pruebas se actualizan en esas tareas.
- El contenido médico del triaje es **provisional**: la bandera `reviewedByDentist` se cambia solo tras la validación de un dentista (T052) y con una versión nueva; mientras tanto el flujo no se ofrece en producción.
- Tareas que requieren a una persona: T052 (navegador, SMTP real, Turnstile real, Hostinger y validación dental).
