---

description: "Lista de tareas de la feature 002-calendario-del-medico"
---

# Tasks: Calendario del médico (agenda)

**Input**: Documentos de diseño en `/specs/002-calendario-del-medico/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS. La constitución (principio V) exige pruebas del comportamiento nuevo, escritas antes o junto con la implementación y **fallando antes de implementar** las reglas de negocio. Cada historia empieza con sus pruebas. Son obligatorias las de concurrencia, aislamiento y registro de acciones.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US5 de `spec.md`) para implementarlas y probarlas de forma independiente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- Sin `any` salvo justificación en comentario; sin `console.log`; sin secretos en código ni tests.
- Toda entrada externa se valida con zod antes de usarse; SQL siempre parametrizado.
- Toda función de repositorio o servicio de agenda recibe `TenantContext` como **primer** parámetro y filtra por `doctor_id`; el médico nunca sale de un parámetro de la petición.
- Toda mutación de agenda pasa por `withCalendarLock` (T010); ningún otro camino escribe `appointment` ni `calendar_block`.
- Los registros técnicos nunca incluyen nombres, correos ni teléfonos de pacientes; solo identificadores.
- Cada tarea termina con `npm run lint && npm run typecheck && npm run test` en verde para lo que toca (vitest por PowerShell con ruta `C:\…`; el conjunto completo tarda mucho: correrlo en segundo plano y sin editar código mientras corre).
- Commits pequeños, mensaje en imperativo, uno por tarea o grupo lógico.
- No se instalan dependencias (el plan no añade ninguna). No se editan `.env*`, lockfiles ni `secrets/`.
- Las pruebas con fechas usan `FixedClock`; las rutas se prueban con `uniqueIp()` y los helpers de `tests/integration/helpers/`.

---

## Phase 1: Setup

**Purpose**: confirmar el punto de partida; no hay dependencias nuevas.

- [x] T001 Confirmar que `npm run lint && npm run typecheck` y la base de pruebas con migraciones `0001`–`0008` están en verde antes de empezar, y que `Intl.supportedValuesOf("timeZone")` incluye las zonas de México listadas en `research.md` (decisión 2) en el Node del entorno (`node -e`); anotar el resultado en el mensaje del primer commit. Sin cambios de código.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: tablas, reglas puras de zona horaria y espacios, bloqueo del médico, registro de acciones y andamiaje de rutas y de pruebas. TODAS las historias dependen de esta fase.

**CRITICAL**: ninguna historia puede empezar hasta terminarla.

- [x] T002 Crear `migrations/0009_calendar.sql` con las tablas de `data-model.md`, citando sus restricciones: `calendar_settings` (PK `doctor_id` FK `doctor`; `slot_minutes` SMALLINT UNSIGNED 15–180 múltiplo de 5, por defecto 45; `gap_minutes` 0–60 múltiplo de 5, por defecto 15; `timezone` VARCHAR(64) por defecto `America/Mexico_City`; `min_notice_minutes` INT UNSIGNED 0–10080, por defecto 120; `max_advance_days` SMALLINT UNSIGNED 1–365, por defecto 60; `updated_at` DATETIME(3); CHECK de rangos y de `min_notice_minutes < max_advance_days * 1440`), `calendar_hours` (`weekday` TINYINT 1–7, `start_minute` 0–1435 múltiplo de 5, `end_minute` 5–1440 mayor que `start_minute`; índice `(doctor_id, weekday, start_minute)`), `appointment` (`status` ENUM('booked','cancelled') por defecto `booked`; `kind` ENUM('regular'); `created_by_role` y `cancelled_by_role` ENUM('doctor','reception'); `cancelled_*` NULL; columna `active_start_utc` DATETIME(3) GENERATED ALWAYS AS (IF(status = 'booked', start_utc, NULL)) STORED; `UNIQUE (doctor_id, active_start_utc)`; índices `(doctor_id, start_utc)` y `(patient_id)`; FK a `doctor`, `patient`, `user`; `end_utc > start_utc` por CHECK), `calendar_block` (`reason` VARCHAR(200) NULL; `end_utc > start_utc` por CHECK; índice `(doctor_id, start_utc, end_utc)`), y `calendar_action_log` (`action` ENUM('settings_updated','appointment_created','appointment_cancelled','block_created','block_removed','block_rejected','patient_lookup'); `outcome` ENUM('ok','rejected'); `appointment_id` y `block_id` NULL sin FK; índices `(doctor_id, occurred_at)` y `(actor_user_id, action, occurred_at)`) con disparadores `BEFORE UPDATE` y `BEFORE DELETE` de una sola sentencia (`SIGNAL SQLSTATE '45000'`, mismo patrón que `patient_access_log` en `migrations/0007_mfa_audit.sql`). Sin campos clínicos ni de triaje. Plan B documentado en `research.md` si MariaDB rechaza la columna generada indexada.
- [x] T003 [P] Escribir `tests/integration/calendar-schema.test.ts`: la migración `0009` se aplica sobre la base de pruebas y es idempotente; dos citas `booked` con el mismo `(doctor_id, start_utc)` violan el índice único, pero una `booked` y una `cancelled` con el mismo inicio, o dos `cancelled`, no; `calendar_action_log` rechaza `UPDATE` y `DELETE`; los CHECK rechazan `end_utc <= start_utc`, duración 17 y `end_minute <= start_minute`. Ampliar: en `tests/integration/append-only.test.ts` añadir `calendar_action_log` al arreglo `TABLES` (disparadores `calendar_action_log_no_delete` y `calendar_action_log_no_update`, con su `seed` y `updateSql`) y añadirla a la expresión regular del recorrido de `src` que prohíbe `UPDATE`/`DELETE` sobre tablas de solo anexar; en `tests/integration/migrate.test.ts` añadir esos dos disparadores a la lista esperada de «los disparadores de solo anexar existen tras migrar» (está ordenada por nombre: quedan primero `calendar_action_log_*`).
- [x] T004 [P] Escribir `tests/unit/zoned-time.test.ts` (debe fallar antes de implementar): conversión local→UTC y UTC→local en `America/Mexico_City` (sin cambio de hora) y `America/Tijuana` con cambio de hora en 2026: una hora local inexistente (salto de primavera) devuelve `null`; una hora repetida (otoño) devuelve la primera ocurrencia; fecha local de un instante UTC cercano a medianoche; rechazo de zonas fuera de la lista cerrada de `research.md` (decisión 2) y de fechas inválidas (`2026-02-30`); suma de días calendario locales a través de un cambio de hora.
- [x] T005 Implementar `src/lib/zoned-time.ts` con `Intl.DateTimeFormat` (`hourCycle: "h23"`), sin dependencias: `ALLOWED_TIMEZONES` (lista cerrada de `research.md`), `isAllowedTimezone`, `localToUtc(zone, "AAAA-MM-DD", minutesOfDay)` → `Date | null`, `utcToLocal(zone, date)` → `{ date, minutesOfDay, weekday }` (lunes = 1), `addLocalDays`, `localDayRangeUtc(zone, date)` (inicio y fin UTC de un día local). T004 debe pasar.
- [x] T006 [P] Escribir `tests/unit/calendar-slots.test.ts` (debe fallar antes de implementar): con 45/15 y franja 9:00–14:00 los inicios son 9:00, 10:00, 11:00, 12:00, 13:00; franja 9:00–10:30 no genera el espacio de 10:00; varias franjas por día; día sin franja → sin espacios; intervalo 0; cambio de hora en `America/Tijuana` (hueco: sin espacio en la hora inexistente; repetición: sin duplicados por inicio UTC); estado `past` si el inicio ≤ ahora; `booked` si una cita vigente se **solapa** (cita 9:00–9:45 y espacio 9:30–10:00 con duración 30 sin intervalo); `blocked` si un bloqueo se solapa; un bloqueo que solo cubre el intervalo entre espacios no bloquea ninguno; la cita cancelada no ocupa; citas vigentes sin espacio correspondiente se devuelven aparte como «fuera del horario actual».
- [x] T007 Implementar `src/lib/calendar-slots.ts`: funciones puras `generateSlotsForDay(settings, hours, localDate)` y `classifySlots(slots, appointments, blocks, now)` según `data-model.md` («Espacio»), más `findOutOfScheduleAppointments`. Definir ahí los tipos `CalendarSettings`, `HoursRange` y `Slot` que usan los demás módulos. T006 debe pasar.
- [x] T008 [P] Escribir `tests/integration/calendar-lock.test.ts` (debe fallar antes de implementar): dos llamadas simultáneas a `withCalendarLock` para el mismo médico se ejecutan una después de la otra (la segunda espera a que la primera confirme); para médicos distintos no se bloquean entre sí; si el callback lanza, se revierte todo; ante deadlock se reintenta; un médico inexistente lanza `NotFoundError`.
- [x] T009 [P] Escribir `tests/integration/calendar-action-log.test.ts` (debe fallar antes de implementar): `logCalendarAction` inserta quién, rol, médico, acción, ids y resultado; `countRecentLookups` cuenta por persona y por médico dentro de una ventana; no se puede actualizar ni borrar (disparadores).
- [x] T010 Implementar `src/modules/calendar/calendar-lock.ts` (`withCalendarLock(db, ctx, fn)`: transacción con `withTransaction` y `SELECT id FROM doctor WHERE id = ? FOR UPDATE` antes de `fn(connection)`; `fn` recibe la conexión) y `src/modules/calendar/action-log.ts` (`logCalendarAction(executor, ctx, entry)` y `countRecentLookups`). T008 y T009 deben pasar.
- [x] T011 [P] Crear el esquema y las funciones de lectura de `src/modules/calendar/settings.ts` y `src/modules/calendar/settings-repository.ts`: valores por defecto de `data-model.md`, `loadSettings(executor, ctx)` (devuelve los valores por defecto si no hay fila y las franjas ordenadas), sin lógica de escritura todavía (se añade en US1). Con pruebas en `tests/integration/calendar-settings-read.test.ts`: sin fila → valores por defecto sin franjas; con fila y franjas → se leen tal cual; otro médico no ve las de este (aislamiento).
- [x] T012 [P] Ampliar `tests/integration/helpers/db.ts` con fábricas `createCalendarSettings(pool, doctorId, overrides)`, `createCalendarHours(pool, doctorId, ranges)`, `createAppointment(pool, { doctorId, patientId, startUtc, endUtc, status?, createdBy })` (crea el vínculo `doctor_patient` si falta), `createBlock(pool, { doctorId, startUtc, endUtc, createdBy })` y limpieza de las tablas nuevas en `clearTables`. Añadir a `tests/integration/helpers/app.ts` los helpers de agenda: `agendaClientFor(t, role)` (médico o recepción con vínculo, con sesión y CSRF) y `localAt(zone, "AAAA-MM-DD", "HH:MM")` → `Date` UTC.
- [x] T013 Crear `src/modules/calendar/routes.ts` con `registerCalendarRoutes(app, services)` vacío y la utilidad común de rutas: resolver `TenantContext` con `services.tenants.resolve` en cada petición, parsear con zod y responder con las vistas; registrar en `src/compose.ts` los servicios que vayan apareciendo (`services.calendar`) y la llamada a `registerCalendarRoutes`. Añadir `tests/contract/calendar-access.test.ts` (debe fallar antes de implementar): sin sesión → 401, paciente y soporte → 403, médico pendiente o rechazado → 403, recepción sin médico activo → 403, recepción con vínculo retirado → 403 en la misma petición, para `GET /agenda`. Registrar también en `tests/integration/route-audit.test.ts` (si audita rutas) las rutas nuevas a medida que se crean.
- [x] T014 [P] Añadir los helpers de vista de agenda en `src/http/views/calendar.ts` (layout común con navegación día/semana/configuración/bloqueos, escape obligatorio con `src/lib/html.ts`, formato de fecha y hora `es-MX` en la zona del consultorio) con `tests/unit/calendar-views.test.ts`: el escape evita HTML en nombre de paciente y motivo; las horas se muestran en la zona del médico, no en UTC.

**Checkpoint**: la base existe; las historias pueden empezar.

---

## Phase 3: User Story 1 - El médico configura su calendario (Priority: P1) 🎯 MVP

**Goal**: el médico guarda duración, intervalo, zona, horario semanal y anticipaciones; recepción no puede.

**Independent Test**: con un médico aprobado, guardar una configuración y comprobar que `generateSlotsForDay` produce los espacios esperados en la zona del consultorio; recepción recibe 403.

### Tests for User Story 1

- [x] T015 [P] [US1] Escribir `tests/unit/calendar-settings.test.ts` (debe fallar antes de implementar): el esquema zod acepta los valores por defecto y rechaza duración 0, 14, 17 y 181; intervalo 7 y 61; zona fuera de la lista; mínima ≥ máxima; máxima 0 y 366; mínima mayor a 7 días; franja con fin ≤ inicio; franjas solapadas en un día; más de 4 franjas en un día; minutos no múltiplos de 5; `HH:MM` mal formado; `24:00` solo como fin.
- [x] T016 [P] [US1] Escribir `tests/integration/calendar-settings-write.test.ts` (debe fallar antes de implementar): guardar reemplaza configuración y franjas completas en una transacción; un guardado con error de validación no cambia nada; guardar registra `settings_updated` con quién y cuándo; guardar **no modifica ni cancela citas ni bloqueos existentes** (crear citas y bloqueos antes y compararlos después); la anticipación guardada está disponible para la comprobación de reserva; **cambiar la zona horaria no altera ni cancela citas ya guardadas** (su `start_utc` y `end_utc` siguen idénticos y solo cambia cómo se muestran).
- [x] T017 [P] [US1] Escribir `tests/contract/calendar-settings.test.ts` (debe fallar antes de implementar): `GET /agenda/configuracion` muestra los valores por defecto a un médico nuevo; `POST` válido → 303 y se refleja en la pantalla; datos inválidos → 400 con mensaje por campo sin guardar nada; recepción en `GET` y `POST` → 403; sin CSRF → 403; médico ajeno no puede afectar la configuración de otro (el médico sale del contexto).

### Implementation for User Story 1

- [x] T018 [US1] Completar `src/modules/calendar/settings.ts` con el esquema zod de configuración y franjas exactamente como `contracts/http-routes.md` (T015 debe pasar), incluyendo conversión de horas de la interfaz (`minNoticeHours` → minutos).
- [x] T019 [US1] Completar `src/modules/calendar/settings-repository.ts` con `saveSettings(db, ctx, input, clock)`: bajo `withCalendarLock`, upsert de `calendar_settings`, borrar e insertar `calendar_hours` y registrar `settings_updated`; solo el médico (`ctx.actor.kind === "doctor"`, si no `ForbiddenError`). T016 debe pasar.
- [x] T020 [P] [US1] Añadir la vista de configuración en `src/http/views/calendar.ts` (7 filas de días con hasta 4 franjas cada una, selector de zona de la lista cerrada, campos numéricos con sus límites, errores por campo).
- [x] T021 [US1] Implementar `GET` y `POST /agenda/configuracion` en `src/modules/calendar/routes.ts` con CSRF y zod; 403 para recepción. T017 debe pasar.
- [x] T022 [US1] Crear `src/modules/calendar/availability.ts` con las funciones que la feature 3 consumirá: `validatePatientBookingWindow(settings, startUtc, now)` (anticipación mínima y máxima del médico, comprobada por el servidor) y `listFreeSlots(...)` apoyada en `calendar-slots.ts`; con `tests/unit/availability.test.ts` (mínima: un espacio dentro de la anticipación mínima se rechaza, justo en el límite se acepta; máxima: justo en el límite se acepta, un instante después se rechaza; el personal de la clínica queda fuera de estas reglas).

**Checkpoint**: US1 funciona sola: un médico configura su calendario y la recepción no puede.

---

## Phase 4: User Story 2 - Ver la agenda por día y por semana (Priority: P1)

**Goal**: el médico y su recepción ven los espacios con su estado, citas con nombre del paciente y bloqueos, en la zona del consultorio.

**Independent Test**: con citas y bloqueos creados por fábricas, abrir la vista de un día y de una semana y comprobar estados, nombre del paciente y que no aparece nada de otro médico.

### Tests for User Story 2

- [x] T023 [P] [US2] Escribir `tests/integration/agenda-service.test.ts` (debe fallar antes de implementar): un día con espacio libre, cita, bloqueo y un espacio pasado → estados correctos; la cita muestra el nombre del paciente y ningún otro dato; una cita fuera del horario actual aparece marcada; una cita cancelada no aparece como ocupada ni se lista; la semana trae siete días de lunes a domingo; navegación a semanas vecinas; el rango de fechas permitido (730 días adelante, 365 atrás); **aislamiento**: citas y bloqueos de otro médico nunca aparecen; el nombre se obtiene con el vínculo `doctor_patient` del médico; 300 citas en una semana responden en menos de 2 s (SC-008) con consultas por rango acotado.
- [x] T024 [P] [US2] Escribir `tests/contract/agenda-view.test.ts` (debe fallar antes de implementar): `GET /agenda` → 303 a `/agenda/dia/<hoy local>`; `GET /agenda/dia/:fecha` y `/agenda/semana/:fecha` para médico y recepción; fecha inválida o fuera de rango → 400/404; recepción con dos médicos solo ve el activo; recepción con vínculo retirado → 403 en esa petición; cambiar de médico activo cambia la agenda; las horas se muestran en la zona del consultorio (probar con `America/Tijuana`).

### Implementation for User Story 2

- [x] T025 [US2] Implementar `src/modules/calendar/appointment-repository.ts` (lecturas): `listAppointmentsInRange(executor, ctx, fromUtc, toUtc)` con nombre del paciente por unión con `doctor_patient` del mismo médico, solo `status = 'booked'`, y `findAppointment(executor, ctx, id)`; todas con `ctx` primero y `doctor_id` en el `WHERE`.
- [x] T026 [P] [US2] Implementar `src/modules/calendar/block-repository.ts` (lecturas): `listBlocksInRange(executor, ctx, fromUtc, toUtc)` y `listUpcomingBlocks(executor, ctx, now)`.
- [x] T027 [US2] Implementar `src/modules/calendar/agenda-service.ts`: `getDay(ctx, localDate, now)` y `getWeek(ctx, localDate, now)` combinan configuración, espacios (T007), citas y bloqueos; valida el rango de fechas; T023 debe pasar.
- [x] T028 [P] [US2] Añadir las vistas de día y semana en `src/http/views/calendar.ts` (tabla de espacios con estado, nombre del paciente enlazado a `/agenda/citas/:id`, marca «fuera del horario actual», botones de nueva cita y bloqueo solo en espacios libres, navegación).
- [x] T029 [US2] Implementar `GET /agenda`, `GET /agenda/dia/:fecha` y `GET /agenda/semana/:fecha` en `src/modules/calendar/routes.ts` con zod; T024 y T013 deben pasar.

**Checkpoint**: US1 + US2: se configura y se ve la agenda.

---

## Phase 5: User Story 3 - Crear una cita en un espacio libre (Priority: P1)

**Goal**: el médico o su recepción agendan para un paciente con cuenta, sin doble reserva, con vínculo médico-paciente y correo de aviso.

**Independent Test**: crear una cita en un espacio libre y comprobar espacio ocupado, vínculo creado y correo encolado; 20 creaciones simultáneas del mismo espacio dejan exactamente una.

### Tests for User Story 3

- [x] T030 [P] [US3] Escribir `tests/integration/appointment-create.test.ts` (debe fallar antes de implementar): crea la cita con inicio y fin UTC según la duración vigente; crea el vínculo `doctor_patient` si falta; encola `appointment_created` en la misma transacción (si el insert falla no queda correo, y viceversa); registra `appointment_created`; rechaza espacio ocupado, bloqueado, pasado, fuera de franja, desfasado respecto a la cuadrícula y a más de 730 días; rechaza una cita que se solape con otra aunque empiece a otra hora (cita 9:00–9:45 y espacio nuevo de 30 min a las 9:30 tras reducir la duración); el personal puede agendar dentro de la anticipación mínima y más allá de la máxima; paciente de otro médico sin boleto → `NotFoundError`; menor bajo tutor → la cita es del menor y el correo va a la cuenta del tutor.
- [x] T031 [P] [US3] Escribir `tests/integration/appointment-concurrency.test.ts` (debe fallar antes de implementar; **obligatoria por la constitución**): 20 creaciones simultáneas del mismo espacio con conexiones distintas → exactamente una cita `booked` y 19 rechazos de conflicto; inserción directa de una segunda cita `booked` con el mismo inicio → el índice único la rechaza (respaldo); creaciones simultáneas de espacios distintos del mismo médico prosperan todas; creaciones de dos médicos distintos no se bloquean entre sí.
- [x] T032 [P] [US3] Escribir `tests/integration/patient-picker.test.ts` (debe fallar antes de implementar): listar pacientes vinculados al médico (solo los suyos); búsqueda por correo exacto devuelve los pacientes de la cuenta con un boleto firmado (HMAC-SHA256 con `SESSION_SECRET`, prefijo `calendar-patient:`, ligado a médico, actor, paciente y caducidad de 15 min); la búsqueda sin resultado devuelve el mismo mensaje uniforme y queda registrada como `rejected`; un boleto de otro médico, de otro actor, alterado o vencido es inválido; la búsqueda número 31 en una hora de la misma persona y la número 61 del mismo médico se rechazan por límite; el correo se normaliza y no distingue mayúsculas; no devuelve teléfono ni fecha de nacimiento.
- [x] T033 [P] [US3] Escribir `tests/integration/appointment-email.test.ts` (debe fallar antes de implementar): al procesar el outbox, `appointment_created` llega a la cuenta del paciente con asunto «Tu cita dental fue agendada» sin datos personales, con médico, fecha y hora en la zona del consultorio y sin enlaces; si la cita ya está cancelada al enviarse, el correo se cancela (`shouldSend` con `FOR UPDATE`); el outbox solo guarda `{ appointmentId }`; si el transporte falla hasta agotar los reintentos (`failed`), la cita sigue `booked` y el espacio sigue ocupado (la cita nunca se deshace por un fallo de correo).
- [x] T034 [P] [US3] Escribir `tests/contract/appointment-create.test.ts` (debe fallar antes de implementar): flujo `GET /agenda/citas/nueva` → `POST /agenda/citas/buscar` → `POST /agenda/citas`; 409 con espacio ocupado, bloqueado o pasado; 400 con espacio inexistente en el horario; 404 con paciente no alcanzable o espacio no libre al abrir la pantalla; 429 con `Retry-After` en el límite de búsquedas; sin CSRF → 403; médico y recepción pueden; recepción revocada → 403; negociación JSON.

### Implementation for User Story 3

- [x] T035 [US3] Implementar `src/modules/calendar/patient-picker.ts`: `listLinkedPatients(ctx)`, `lookupByEmail(ctx, email, now)` (límites contados con `countRecentLookups`, registro `patient_lookup`), `issueTicket` y `verifyTicket` con `node:crypto` (`timingSafeEqual`). T032 debe pasar.
- [x] T036 [US3] Completar `src/modules/calendar/appointment-repository.ts` con las escrituras `insertAppointment(connection, ctx, …)` y `findOverlappingBooked(connection, ctx, startUtc, endUtc)` (consulta de rango `start_utc < fin AND end_utc > inicio AND status = 'booked'`), siempre con `ctx` y dentro de `withCalendarLock`.
- [x] T037 [P] [US3] Implementar `src/modules/calendar/email-templates.ts` con `appointment_created` (con `shouldSend` y `FOR UPDATE`) y `appointment_cancelled` según `contracts/email-notifications.md` (la de cancelación se prueba en US4), registrarlas en `src/mail/templates.ts` y exportarlas como `calendarTemplates`. T033 debe pasar.
- [x] T038 [US3] Implementar `src/modules/calendar/appointment-service.ts` → `createAppointment(ctx, input, clock)`: bajo `withCalendarLock`, recalcula el espacio con `generateSlotsForDay` y exige que `inicio` sea uno de ellos y futuro (y ≤ 730 días), revisa solape con citas vigentes y con bloqueos, comprueba que el paciente esté vinculado o que el boleto sea válido (entonces `linkPatientToDoctor` en la misma transacción), inserta, encola `appointment_created` con `enqueueEmail` sobre la misma conexión y registra la acción. Traduce el choque del índice único a un conflicto 409. T030 y T031 deben pasar.
- [x] T039 [P] [US3] Añadir las vistas de nueva cita (paciente vinculado o búsqueda por correo, resultado con nombres y boleto) y de detalle de cita en `src/http/views/calendar.ts`.
- [x] T040 [US3] Implementar `GET /agenda/citas/nueva`, `POST /agenda/citas/buscar`, `POST /agenda/citas` y `GET /agenda/citas/:id` en `src/modules/calendar/routes.ts` con zod, CSRF y los códigos de `contracts/http-routes.md`. T034 debe pasar. El detalle de la cita enlaza a la ruta auditada de la feature 1 y no muestra más datos del paciente que el nombre.

**Checkpoint**: se puede agendar sin doble reserva y el paciente recibe su aviso.

---

## Phase 6: User Story 4 - Cancelar una cita (Priority: P1)

**Goal**: cancelar libera el espacio de inmediato, registra quién y cuándo, y avisa al paciente.

**Independent Test**: cancelar una cita futura y comprobar espacio libre, registro y correo; cancelar dos veces, una pasada y una ajena.

### Tests for User Story 4

- [x] T041 [P] [US4] Escribir `tests/integration/appointment-cancel.test.ts` (debe fallar antes de implementar): cancelar una cita futura → `cancelled` con quién (usuario y rol) y cuándo, el espacio vuelve a estar libre en `getDay`, correo `appointment_cancelled` encolado en la misma transacción, acción registrada; cancelar otra vez → conflicto sin segundo correo; cita pasada (fin ≤ ahora) → rechazo; cita de otro médico → `NotFoundError`; una cita cancelada permite crear otra en el mismo espacio.
- [x] T042 [P] [US4] Escribir `tests/integration/appointment-cancel-concurrency.test.ts` (debe fallar antes de implementar; **obligatoria**): cancelar y crear sobre el mismo espacio a la vez, repetido 20 veces → siempre como máximo una cita `booked` en ese espacio y sin errores de interbloqueo sin reintentar; dos cancelaciones simultáneas de la misma cita → una prospera y una recibe conflicto, y se encola un solo correo; cancelar antes de que el outbox envíe `appointment_created` → ese correo se cancela y solo sale el de cancelación.
- [x] T043 [P] [US4] Escribir `tests/contract/appointment-cancel.test.ts` (debe fallar antes de implementar): `POST /agenda/citas/:id/cancelar` → 303; ya cancelada o pasada → 409; ajena → 404; sin CSRF → 403; recepción revocada → 403; `appointment_cancelled` llega con asunto «Tu cita dental fue cancelada» sin datos personales.

### Implementation for User Story 4

- [x] T044 [US4] Completar `src/modules/calendar/appointment-repository.ts` con `cancelAppointment(connection, ctx, id, actor, now)` (`UPDATE … WHERE id = ? AND doctor_id = ? AND status = 'booked' AND end_utc > ?`, devolviendo si afectó una fila).
- [x] T045 [US4] Completar `src/modules/calendar/appointment-service.ts` con `cancelAppointment(ctx, id, clock)`: bajo `withCalendarLock`, distingue inexistente o ajena (404) de ya cancelada o pasada (409), cancela, encola `appointment_cancelled` y registra la acción. T041 y T042 deben pasar.
- [x] T046 [US4] Implementar `POST /agenda/citas/:id/cancelar` en `src/modules/calendar/routes.ts` y el botón «Cancelar cita» (con confirmación en la pantalla de detalle) en `src/http/views/calendar.ts`. T043 debe pasar.

**Checkpoint**: ciclo completo de citas: crear y cancelar.

---

## Phase 7: User Story 5 - Bloquear y desbloquear horarios (Priority: P2)

**Goal**: bloquear solo horarios sin cita (rechazo total con lista de conflictos) y desbloquear bloqueos completos.

**Independent Test**: bloquear un rango libre; intentar bloquear uno con una cita y recibir la lista sin cambios; cancelar la cita y repetir con éxito; desbloquear.

### Tests for User Story 5

- [x] T047 [P] [US5] Escribir `tests/integration/block-create.test.ts` (debe fallar antes de implementar): bloquear un rango sin citas → los espacios quedan `blocked` y no se pueden agendar; rango con una o varias citas vigentes con fin futuro → rechazo **total** con la lista (id, inicio, nombre del paciente; máximo 50 y el total), cero filas insertadas y acción `block_rejected`; tras cancelar esas citas el mismo bloqueo se aplica; una cita ya pasada dentro del rango no impide el bloqueo; una cita cancelada tampoco; rango con fin pasado, fin ≤ inicio o más de 366 días → rechazo; bloqueos solapados se aceptan; motivo de más de 200 caracteres → rechazo; un bloqueo nunca modifica citas (comparar antes y después).
- [x] T048 [P] [US5] Escribir `tests/integration/block-concurrency.test.ts` (debe fallar antes de implementar; **obligatoria por la constitución**): bloquear y crear cita sobre el mismo horario a la vez, repetido 20 veces → nunca existen un bloqueo y una cita vigente que se solapen (consulta de verificación tras cada ronda) y una de las dos operaciones recibe conflicto; dos bloqueos solapados simultáneos prosperan ambos; bloquear y cancelar a la vez → resultado consistente (si la cancelación gana, el bloqueo se aplica; si el bloqueo gana, se rechaza con la cita en la lista).
- [x] T049 [P] [US5] Escribir `tests/integration/block-remove.test.ts` (debe fallar antes de implementar): desbloquear borra el bloqueo completo y libera sus espacios; con dos bloqueos solapados, borrar uno no libera lo que el otro cubre; bloqueo de otro médico → `NotFoundError`; queda `block_removed` en el registro; recepción y médico pueden con las mismas reglas y la acción queda a nombre de cada persona.
- [x] T050 [P] [US5] Escribir `tests/contract/block-routes.test.ts` (debe fallar antes de implementar): `GET /agenda/bloqueos`; `POST /agenda/bloqueos` válido → 303; con citas → 409 con la lista en HTML y en JSON (`appointments_in_range`) y sin cambios; `POST /agenda/bloqueos/espacio` desde un espacio libre; `POST /agenda/bloqueos/:id/eliminar` → 303; ajeno → 404; validación → 400; sin CSRF → 403; recepción revocada → 403.

### Implementation for User Story 5

- [x] T051 [US5] Completar `src/modules/calendar/block-repository.ts` con `insertBlock`, `deleteBlock` y `findConflictingAppointments(connection, ctx, fromUtc, toUtc, now)` (citas `booked` con `start_utc < fin AND end_utc > inicio AND end_utc > ahora`, con nombre del paciente, `LIMIT 50` más conteo total).
- [x] T052 [US5] Implementar `src/modules/calendar/block-service.ts` → `createBlock(ctx, input, clock)`, `blockSlot(ctx, startLocal, clock)` y `removeBlock(ctx, id, clock)` bajo `withCalendarLock`, con una `BlockConflictError` que lleva la lista y el total, y registro de `block_created`, `block_rejected` y `block_removed`. El rechazo del registro `block_rejected` se escribe fuera de la transacción que revirtió (o en una propia) para que no se pierda. T047, T048 y T049 deben pasar.
- [x] T053 [P] [US5] Añadir las vistas de bloqueos y del conflicto (lista de citas con fecha, hora y nombre, y el texto «Cancela estas citas y vuelve a intentar») en `src/http/views/calendar.ts`, y el botón de bloquear espacio libre en la agenda.
- [x] T054 [US5] Implementar `GET /agenda/bloqueos`, `POST /agenda/bloqueos`, `POST /agenda/bloqueos/espacio` y `POST /agenda/bloqueos/:id/eliminar` en `src/modules/calendar/routes.ts` con zod, CSRF y el 409 en HTML y JSON. T050 debe pasar.

**Checkpoint**: las cinco historias funcionan; la agenda queda completa.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T055 [P] Escribir `tests/integration/calendar-isolation.test.ts`: con dos médicos con citas, bloqueos y configuración, cada ruta y servicio de agenda (día, semana, detalle, cancelar, bloquear, eliminar bloqueo, configuración, búsqueda y listado de pacientes) con el identificador del otro médico responde 404 o no devuelve nada, y recepción de un médico no actúa sobre el otro; recorrer todas las funciones exportadas de los repositorios de `calendar` para comprobar que exigen `TenantContext` (como `tests/integration/tenant-isolation.test.ts`).
- [x] T056 [P] Escribir `tests/integration/calendar-log-redaction.test.ts`: tras recorrer los flujos (crear, cancelar, bloquear con conflicto, búsqueda por correo) los registros técnicos y las filas de `calendar_action_log` no contienen nombres, correos ni teléfonos de pacientes; el `payload_ref` del outbox solo tiene `appointmentId`.
- [x] T057 [P] Escribir `tests/integration/calendar-timezone-flow.test.ts`: flujo completo en `America/Tijuana` a través del cambio de hora (configurar, ver, agendar en el día del cambio) con hora local inexistente y repetida; las horas se guardan en UTC y se muestran en la zona del consultorio.
- [x] T058 Revisar `tests/contract/calendar-access.test.ts` y `tests/integration/route-audit.test.ts` para que cubran **todas** las rutas de `contracts/http-routes.md` (sin sesión 401, rol no permitido 403, ajena 404, sin CSRF 403, validación 400) y que ninguna ruta `GET` cambie estado.
- [x] T059 [P] Actualizar `docs/configuration.md` con la sección de la agenda (valores por defecto, límites, zonas permitidas, topes de 730 y 366 días, límites de búsqueda por correo) y crear `docs/decisions/0003-calendario.md` con las decisiones técnicas de `research.md` y los riesgos abiertos (columna generada y disparadores en MariaDB/Hostinger; retención de citas; listado de pacientes visible para el médico; la búsqueda por correo exacto muestra los nombres de los pacientes de esa cuenta, incluidos menores, y confirma que la cuenta existe: se acepta igual que el oráculo del alta de paciente de la feature 1, con límite de 30/hora por persona y 60/hora por médico y registro en `calendar_action_log`). Además, en `docs/decisions/0001-resumen-grill-me.md` marcar como **resuelto** el supuesto abierto 12 y anotar lo decidido (valores por defecto y límites de la anticipación, citas existentes que se conservan al reducir la máxima, bloqueo rechazado con la lista de citas en conflicto) con la fecha y el enlace a `0003-calendario.md`.
- [x] T060 Ejecutar el conjunto completo de pruebas (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) por PowerShell con ruta `C:\…` en segundo plano, sin editar código mientras corre; corregir fallos; comprobar los escenarios 1–31 de `quickstart.md` y la ausencia de `console.log` y de `any` sin justificar.
- [x] T061 Revisión independiente antes de dar la feature por terminada: `code-review` y `/security-review` sobre el diff de la feature (con atención a la invariante de no doble reserva, el boleto firmado, el aislamiento y los registros), verificando cada hallazgo antes de aplicarlo; documentar el resultado y corregir. **Hecha (2026-11-22)**: revisiones independientes de código y de seguridad; resultado y correcciones en `docs/decisions/0003-calendario.md`.
- [ ] T062 Recorrido manual en navegador con SMTP real (configurar → crear cita → cancelar → bloquear con conflicto → cancelar → bloquear → desbloquear, viendo los dos correos) y, en el despliegue de pruebas de Hostinger, comprobar la columna generada indexada de `appointment` y los disparadores de `calendar_action_log`, y repetir los escenarios 17, 21 y 25 de `quickstart.md` contra MariaDB. **Requiere a una persona**; dejar anotado el estado igual que la T123 de la feature 1. **PENDIENTE (requiere a una persona): recorrido manual en navegador con SMTP real y pruebas en MariaDB/Hostinger; no se puede automatizar aquí.**
- [x] T063 Verificar que `spec.md` refleja lo implementado (FR y supuestos), actualizar `specs/002-calendario-del-medico/checklists/requirements.md` si cambió algo y marcar las tareas hechas. **Hecha**: `contracts/http-routes.md` ajustado a lo implementado (campos planos de franjas, JSON de pantallas); sin cambios en los FR.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; **bloquea todas las historias**. Orden interno: T002 → T003; T004 → T005; T006 → T007 (necesita T005); T008 y T009 → T010 (necesita T002); T011 y T012 necesitan T002; T013 y T014 después de T010.
- **US1 (Phase 3)**: depende de la Fase 2. Es el MVP: sin configuración no hay espacios.
- **US2 (Phase 4)**: depende de US1 (lee configuración y franjas) y de la Fase 2.
- **US3 (Phase 5)**: depende de US2 (necesita lecturas de citas y la pantalla de agenda) y de T010 y T037.
- **US4 (Phase 6)**: depende de US3 (usa el repositorio y el servicio de citas y la plantilla de cancelación de T037).
- **US5 (Phase 7)**: depende de US3 (conflicto con reservas) y de US4 (el flujo «cancelar y luego bloquear»); el esquema y las lecturas de bloqueos ya existen desde la Fase 2 y la Fase 4.
- **Polish (Phase 8)**: depende de todas las historias.

### Within Each User Story

- Pruebas primero y **deben fallar** antes de implementar la regla de negocio.
- Repositorio → servicio → vistas → rutas.
- Cada historia termina con su punto de control y un commit antes de pasar a la siguiente.

### Parallel Opportunities

- Fase 2: T003, T004, T006, T008, T009, T011, T012 y T014 son paralelizables entre sí tras sus dependencias.
- Dentro de cada historia, todas las tareas de pruebas marcadas [P] (archivos distintos) pueden escribirse en paralelo.
- Las vistas (T020, T028, T039, T053) comparten `src/http/views/calendar.ts`: aunque llevan [P] respecto a otras tareas, se aplican de una en una.
- No se debe ejecutar la suite de base de datos de forma concurrente en varios procesos.

---

## Implementation Strategy

### MVP First (US1 → US2)

1. Fase 1 y Fase 2 completas.
2. US1: configuración y reglas de anticipación.
3. US2: agenda por día y semana.
4. **Detenerse y validar**: un médico configura y ve su agenda (sin citas todavía).

### Incremental Delivery

1. Base + US1 + US2 → agenda visible.
2. US3 → se puede agendar sin doble reserva.
3. US4 → se puede cancelar y avisar.
4. US5 → bloqueos con la regla de conflictos.
5. Polish → aislamiento, registros, zona horaria, revisiones y recorrido manual.

### Notas

- La reserva por el propio paciente, el micrositio y los recordatorios son la feature 3; `availability.ts` (T022) deja lista la regla de anticipación para ella.
- Tareas que requieren a una persona: T062 (navegador, SMTP real y Hostinger).
