---

description: "Lista de tareas de la feature 005-panel-de-soporte"
---

# Tasks: Panel de soporte

**Input**: Documentos de diseño en `/specs/005-panel-de-soporte/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS. La constitución (principio V) exige pruebas del comportamiento nuevo, escritas antes o junto con la implementación y **fallando antes de implementar** las reglas de negocio. Cada historia empieza con sus pruebas. Son obligatorias las de concurrencia de acciones de soporte, aislamiento (soporte sin datos de pacientes), historial de solo anexar, estado aplicado en reservas y que la vista de correos **nunca** muestre contenido ni categoría.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US5 de `spec.md`) para implementarlas y probarlas de forma independiente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- Sin `any` salvo justificación en comentario; sin `console.log`; sin secretos en código ni tests; sin dependencias nuevas.
- Toda entrada externa se valida con zod antes de usarse; SQL siempre parametrizado.
- **Soporte no ve datos de pacientes** (FR-022): ningún archivo de `src/modules/support/` consulta las tablas `patient`, `data_authorization` ni selecciona nombres, correos o teléfonos de pacientes; las citas solo se **cuentan** por médico. Nunca se selecciona `email_outbox.payload_ref` ni se muestra la categoría de urgencia.
- Toda acción de cambio exige `reason` (1 a 500 caracteres), `confirm = yes` y, en cambios de estado, `from`; corre en una transacción que bloquea la fila del médico (`SELECT … FOR UPDATE`), compara `from` con el estado real y escribe una entrada en `support_action_log` en la **misma** transacción.
- El panel no tiene impersonación ni cambia cuentas de soporte; las rutas resuelven el id contra `doctor`, nunca contra `user`.
- Los textos de los correos de estado son fijos y **nunca** incluyen el motivo interno.
- Las pruebas de integración se ejecutan por PowerShell con ruta `C:\…` (ver memoria del proyecto) y fijan el reloj **antes** de abrir sesiones.

---

## Phase 1: Setup

- [ ] T001 Crear `migrations/0014_support_panel.sql` según `data-model.md`: `ALTER TABLE doctor` con `account_state ENUM('active','suspended','read_only') NOT NULL DEFAULT 'active'`, `account_state_changed_at DATETIME(3) NULL` y `account_state_changed_by BIGINT UNSIGNED NULL` (FK a `user(id)`); `ALTER TABLE email_outbox ADD last_error_code VARCHAR(40) NULL`; `CREATE TABLE support_action_log` (`id`, `support_user_id` FK, `action ENUM('approve','reject','release_cedula','suspend','read_only','reactivate','change_slug','retry_email','cancel_email','view_cedula')`, `target_type ENUM('doctor','site','email')`, `target_id`, `reason VARCHAR(500) NULL`, `occurred_at DATETIME(3)`, índices `(occurred_at, id)`, `(support_user_id, occurred_at)`, `(action, occurred_at)`) con disparadores `BEFORE UPDATE` y `BEFORE DELETE` de una sola sentencia que lanzan `SQLSTATE '45000'`; copiar a esa tabla las filas de `doctor_review` (`approved`→`approve`, `rejected`→`reject`, `cedula_released`→`release_cedula`) con su autor y fecha; `CREATE TABLE site_slug_reservation` (`slug VARCHAR(40)` PK, `doctor_id` FK, `reserved_until DATETIME(3)`); `CREATE TABLE pilot_metric_daily` (PK `(day, doctor_id)`, `started`, `completed`, `duration_sum_seconds BIGINT UNSIGNED`, `duration_count`, `under_target_count`, todas `UNSIGNED NOT NULL DEFAULT 0`). Sin disparadores de varias sentencias (compatibilidad con MariaDB).
- [ ] T002 Actualizar `tests/integration/helpers/db.ts`: `clearTables` y `resetDatabase` incluyen las tablas nuevas; factories `createSupportUser` (con doble factor verificado, reutilizando lo que ya usa `createSupportWithMfa` de `tests/integration/helpers/app.ts`), `setAccountState(pool, doctorId, state)`, `createEmail(pool, {template, status, attempts, lastErrorCode, to})` y `createMetricRow`.
- [ ] T003 [P] Escribir `tests/integration/support-schema.test.ts` (debe fallar sin T001): columnas y valores de `account_state` (defecto `active`), `support_action_log` rechaza `UPDATE` y `DELETE` directos, el historial previo de `doctor_review` se copió con autor y fecha, `site_slug_reservation` y `pilot_metric_daily` existen con sus llaves, `last_error_code` es nulo por defecto, y recorrer `information_schema` confirmando que **ninguna tabla nueva tiene columnas de categoría, nombre, correo o teléfono de pacientes**.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Antes de cualquier historia: ficha del médico con estado, historial, plantillas y utilidades compartidas.**

- [ ] T004 Ampliar `src/modules/doctors/doctor-repository.ts`: la ficha `Doctor` expone `accountState`, `accountStateChangedAt` y `accountStateChangedBy`; tipo `AccountState = "active" | "suspended" | "read_only"` exportado desde ese módulo.
- [ ] T005 [P] Escribir `tests/unit/support-state.test.ts`: tabla de transiciones válidas (`active→suspended`, `active→read_only`, `read_only→suspended`, `suspended→active`, `read_only→active`) y rechazo de todas las demás; enmascarado de correo (`j***@dominio.com`, un solo carácter local, dominio con subdominios); `reason` recortado de 1 a 500 caracteres y rechazo de vacío o de más de 500.
- [ ] T006 Crear `src/modules/support/state-rules.ts` con `canTransition(from, action)`, `maskEmail(email)` y los esquemas zod compartidos (`reasonSchema`, `confirmSchema`, `stateActionBody`, `idParams`, `pageQuery`) hasta que T005 pase.
- [ ] T007 Escribir `tests/integration/support-log.test.ts` (parte de base): `appendSupportAction` registra persona, acción, objetivo, motivo y fecha; `listSupportActions` devuelve de la más reciente a la más antigua, 50 por página, y filtra por persona, acción y rango de fechas; `desde > hasta` es un error de validación.
- [ ] T008 Crear `src/modules/support/action-log.ts`: `appendSupportAction(executor, entry)` (solo se llama con la conexión de la transacción que hace el cambio) y `listSupportActions(db, filters)` con paginación y filtros; consultas parametrizadas; sin función de edición ni borrado.
- [ ] T009 Hacer que `src/modules/support/support-service.ts` (aprobar, rechazar, liberar cédula) escriba su entrada en `support_action_log` en la misma transacción que la decisión (sin quitar `doctor_review`); ampliar `tests/integration/support-review.test.ts` para comprobar que aprobar, rechazar y liberar cédula dejan su entrada en `support_action_log` con autor y fecha.
- [ ] T010 [P] Crear `src/modules/support/email-templates.ts` con `doctor_account_suspended`, `doctor_account_read_only`, `doctor_account_reactivated` y `doctor_site_slug_changed` según `contracts/email-notifications.md` (texto fijo, sin motivo, `payload` solo `{ doctorId }` y `slug` en el cambio de enlace, sin `sensitiveKeys`) y registrarlas en `src/mail/templates.ts`; prueba en `tests/unit/support-email-templates.test.ts` que ningún texto contiene el motivo ni caracteres del `payload` más allá del enlace.
- [ ] T011 Crear `src/modules/support/support-views.ts` con las piezas comunes del panel: navegación (Inicio, Médicos, Micrositios, Correos, Métricas, Historial), formulario de acción con `reason`, casilla `confirm` y campo `from`, paginador y mensajes de 400/409 y, junto a cada campo `reason`, la advertencia «No escribas datos de pacientes: el motivo queda en el historial»; todo con `html` de `src/lib/html.js` (escapado) y `noindex`.
- [ ] T012 Cablear en `src/compose.ts` (interfaz `Services` y `createServices`) los servicios `accountState` (T018), `mailQueue` (T028), `siteAdmin` (T031) y `metrics` (T038); aquí solo se preparan el campo y el tipo de cada uno, y la implementación llega con su tarea y en `src/http/app.ts` las cabeceras `Cache-Control: no-store` y `X-Robots-Tag` para `/soporte`; límites de tasa del contrato (120/min lectura por IP, 30/hora cambios por cuenta) en un `const` compartido de `support-routes.ts`.

**Checkpoint**: la base soporta estado, historial y plantillas; las historias pueden empezar.

---

## Phase 3: User Story 1 - Soporte gestiona el ciclo de vida de la cuenta de un médico (Priority: P1) 🎯 MVP

**Goal**: suspender, poner en solo lectura y reactivar cuentas con motivo y confirmación, con el estado aplicado en acceso, agenda y reservas.

**Independent Test**: suspender un médico aprobado y comprobar que no entra y que su micrositio no acepta reservas; reactivar; repetir con solo lectura (consulta pero no modifica; el paciente aún cancela).

### Tests for User Story 1

- [ ] T013 [P] [US1] `tests/integration/support-lifecycle.test.ts`: suspender → el usuario médico queda `disabled`, sus sesiones revocadas, el login responde con el mensaje uniforme de siempre, su recepción recibe 403 y el aviso fijo queda en cola; reactivar → todo vuelve y el micrositio recupera su estado; no se puede suspender, poner en solo lectura ni reactivar a un médico pendiente o rechazado (409); aprobar una cuenta nunca la deja en solo lectura ni suspendida (FR-011); `from` obsoleto → 409 sin historial duplicado; con el médico suspendido su recepción ya no lo ve en el selector de consultorios ni entra a él; el médico pierde el acceso y el micrositio deja de aceptar reservas **en la misma petición** que confirma la suspensión (SC-003).
- [ ] T014 [P] [US1] `tests/integration/support-readonly.test.ts`: con `read_only`, el médico y su recepción reciben 200 en `GET` de agenda y detalle y 403 con «Tu cuenta está en solo lectura» en `POST`/`PUT`/`DELETE` de citas, bloqueos, configuración, franjas, publicación e invitaciones; `isAcceptingBookings` es falso (reserva y urgencia rechazadas con `SiteUnavailableError`); el paciente **sí** cancela su cita (por sesión y por enlace) y el espacio queda libre; las citas futuras se conservan; recorrer todas las rutas con método de escritura registradas en el servidor y comprobar que ninguna escapa al rechazo; **`POST /agenda/citas/buscar` (búsqueda de pacientes por POST) también se rechaza en solo lectura**: es una decisión documentada, porque en ese estado no hay a quién agendar, y la prueba la fija.
- [ ] T015 [P] [US1] `tests/integration/support-concurrency.test.ts`: dos acciones de soporte simultáneas sobre la misma cuenta (suspender y poner en solo lectura) terminan con un único estado válido y una entrada de historial por acción aplicada; 20 reservas y una urgencia entrantes durante una suspensión terminan cada una completa o rechazada, sin cita a medias ni reserva posterior al cambio (misma garantía de `withCalendarLock`); tres médicos y dos personas de soporte actuando a la vez (SC-008).
- [ ] T016 [P] [US1] `tests/contract/support-lifecycle.test.ts` (con `fastify.inject`): rutas `POST /soporte/medicos/:id/suspender|solo-lectura|reactivar` según `contracts/http-routes.md`: 400 sin motivo o sin `confirm`, 400 con `from` fuera del enum, CSRF obligatorio (403 sin token), 404 si el médico no existe, 403 para médico, recepción y paciente, 401 sin sesión, redirección a alta del doble factor si soporte no lo tiene; el detalle muestra estado, quién y cuándo y **solo el número** de citas futuras (sin nombres); pasar el id de una **cuenta de soporte** (incluida la propia) a cualquier ruta `:id` de médicos responde 404 y no cambia nada (FR-013).
- [ ] T017 [P] [US1] `tests/integration/support-isolation.test.ts`: prueba estática que lee todos los archivos de `src/modules/support/` y falla si aparecen las tablas `patient` o `data_authorization`, las columnas de nombre, correo o teléfono de pacientes, `payload_ref` o `category`; excepción justificada y documentada en la propia prueba: `COUNT(*)` sobre `appointment` filtrado por médico; y una prueba de que ninguna ruta de `/soporte` crea una sesión (no hay impersonación).

### Implementation for User Story 1

- [ ] T018 [US1] Crear `src/modules/support/account-state-service.ts`: `suspend`, `setReadOnly` y `reactivate` (`db`, `clock`, `doctorId`, `supportUserId`, `reason`, `from`) en una transacción: `SELECT … FOR UPDATE` de la fila del médico, exige `approval_status = 'approved'` y `account_state = from` y la transición válida (`state-rules.ts`), actualiza `account_state`, `account_state_changed_at` y `account_state_changed_by`, en `suspend` pone `user.status = 'disabled'` del médico y revoca sus sesiones (`session.revoked_at`), en `reactivate` desde suspendido restaura `user.status = 'active'`, escribe `support_action_log` y encola el correo fijo (T010) en la misma transacción; `ConflictError("state_changed")` si falla alguna comprobación.
- [ ] T019 [US1] Aplicar el estado en `src/modules/reception/tenant-resolver.ts` y `src/modules/doctors/guards.ts` (`requireApprovedDoctor`, `loadDoctor` donde corresponda): `suspended` → `ForbiddenError`; `read_only` → `ForbiddenError("Tu cuenta está en solo lectura.")` si el método no es `GET` ni `HEAD`; para recepción se comprueba el estado del médico activo de la sesión; además `src/modules/reception/reception-repository.ts` (la comprobación de membresía y la lista de consultorios de recepción, hoy solo con `approval_status = 'approved'`) excluye a los médicos con `account_state = 'suspended'`, y `src/modules/reception/invitation-service.ts` no acepta invitaciones de un médico suspendido ni en solo lectura.
- [ ] T020 [US1] Aplicar el estado en `src/modules/site/site-repository.ts`: `isAcceptingBookings` y la consulta de listado (`approval_status = 'approved'` más `account_state = 'active'`), y en `src/modules/site/site-resolver.ts` tratar `suspended` y `read_only` como «no acepta reservas» (pantalla «confirma por teléfono con el consultorio» de la feature 3/4); verificar que `src/modules/urgent/routes.ts` y `booking-service.ts` heredan el rechazo sin cambios propios.
- [ ] T021 [US1] Comprobar en `src/modules/auth/login-service.ts` y `src/modules/auth/sessions.ts` que un usuario `disabled` recibe la respuesta uniforme y que las sesiones revocadas dejan de valer en la siguiente petición; solo ajustar si T013 falla (sin duplicar lógica).
- [ ] T022 [US1] Ampliar `src/modules/support/support-routes.ts` y `support-views.ts`: lista con filtro `estado` (`pending|approved|rejected|suspended|read_only|all`) y búsqueda `q` (≤ 100, comodines `%` y `_` escapados), detalle con estado operativo, quién y cuándo, estado del micrositio, número de citas futuras (`COUNT(*)` filtrado por médico) y los tres botones según el estado, y las rutas `POST /soporte/medicos/:id/suspender|solo-lectura|reactivar` con `parseInput` (zod), CSRF, límite y 303 al detalle; sobre médicos no aprobados responden 409.
- [ ] T023 [US1] Mostrar en `src/http/views/calendar.ts` un aviso «Tu cuenta está en solo lectura» en la agenda del médico y la recepción cuando aplique, y en `src/http/views/site.ts` el texto de «confirma por teléfono» ya existente para ambos estados.

**Checkpoint**: US1 completa y demostrable (MVP): soporte opera el estado de cualquier cuenta con todas las garantías.

---

## Phase 4: User Story 2 - Soporte vigila micrositios y cola de correos (Priority: P2)

**Goal**: ver el estado de los micrositios y de la cola sin contenido, reintentar o cancelar correos y cambiar el enlace de un micrositio desde el panel.

**Independent Test**: dejar correos pendientes y fallidos y comprobar conteos sin contenido ni categoría; reintentar un fallido; cambiar un enlace y comprobar el nuevo, el anterior (404) y la reserva.

### Tests for User Story 2

- [ ] T024 [P] [US2] `tests/integration/support-mail.test.ts`: conteos por estado y antigüedad del pendiente más viejo; la lista de fallidos solo trae `id`, tipo, destinatario enmascarado, fecha, intentos y código; **ninguna respuesta (HTML ni JSON) contiene `payload_ref`, asunto, cuerpo, destinatario completo ni categoría**, también con un `doctor_urgent_notice` fallido en la cola; reintentar un tipo reintentable → `queued`, 0 intentos, `next_attempt_at` ahora, historial `retry_email`; `doctor_urgent_notice` y estados distintos de `failed` → 409; cancelar `failed` o `queued` → `cancelled` con historial `cancel_email`; `processOutbox` guarda `last_error_code` cerrado al fallar y nunca texto del servidor; con 200 correos fallidos la vista pagina de a 50 y responde sin errores.
- [ ] T025 [P] [US2] `tests/integration/support-sites.test.ts`: lista y conteos por estado con filtro; cambiar el enlace en una transacción: el nuevo funciona, el anterior da 404, queda `site_slug_reservation` por 90 días a nombre del dueño, el mismo dueño puede recuperarlo, otro médico recibe 409 `slug_taken` al crearlo o cambiarlo a ese nombre (y lo logra al vencer la reserva con el reloj avanzado), formato inválido → 400 con mensajes por campo, se registra `change_slug`, el aviso fijo sale con el enlace nuevo y sin motivo; la fila `site_updated` con rol `support` de `calendar_action_log` se mantiene.
- [ ] T026 [P] [US2] `tests/contract/support-ops.test.ts`: rutas `GET /soporte/micrositios`, `GET/POST /soporte/micrositios/:doctorId/enlace`, `GET /soporte/correos`, `POST /soporte/correos/:id/reintentar|cancelar` según el contrato: roles, CSRF, validación de `id`, `pagina`, `estado`, `reason` y `confirm`, 404 para ids inexistentes.

### Implementation for User Story 2

- [ ] T027 [US2] En `src/mail/outbox.ts` guardar `last_error_code` al fallar (clasificación a un conjunto cerrado: `smtp_unreachable`, `smtp_rejected`, `smtp_timeout`, `template_error`, `other`) sin texto libre del servidor, y limpiarlo al reintentar con éxito; ajustar `tests/integration/` existentes de outbox si cambian expectativas.
- [ ] T028 [US2] Crear `src/modules/support/mail-queue-service.ts`: `queueSummary(db, page)` seleccionando solo `id`, `template`, `status`, `attempts`, `created_at`, `next_attempt_at`, `last_error_code` y el destinatario enmascarado en SQL, **nunca** `payload_ref`; `retryEmail` y `cancelEmail` en transacción con `FOR UPDATE`, excluyendo las plantillas con `sensitiveKeys` (consultar el registro de `src/mail/templates.ts`), con historial en la misma transacción.
- [ ] T029 [US2] Refactorizar `src/modules/site/change-slug.ts` para recibir `supportUserId` (la versión de línea de comandos `scripts/change-site-slug.ts` busca el id por correo y llama a la misma función); al cambiar, insertar o actualizar `site_slug_reservation` del nombre anterior con `reserved_until` = ahora + 90 días; rechazar el nombre nuevo si está reservado por otro médico con `reserved_until > ahora`; escribir `change_slug` en `support_action_log`, encolar `doctor_site_slug_changed` y mantener `site_updated` del registro de la agenda.
- [ ] T030 [US2] Aplicar la misma comprobación de reserva al crear o cambiar el nombre por el médico en el servicio de publicación del micrositio (buscar en `src/modules/site/` el punto donde se asigna `slug` al crear) con el mismo `ConflictError("slug_taken")`.
- [ ] T031 [US2] Crear `src/modules/support/site-admin-service.ts` (`listSites(db, estado)` con conteos por estado, nombre del enlace y última publicación; sin datos de pacientes) y ampliar `support-routes.ts` y `support-views.ts` con `GET /soporte/micrositios`, `GET/POST /soporte/micrositios/:doctorId/enlace`, `GET /soporte/correos`, `POST /soporte/correos/:id/reintentar|cancelar`; respuestas JSON con las mismas estructuras y sin `payload`.

**Checkpoint**: US1 y US2 funcionan de forma independiente.

---

## Phase 5: User Story 3 - Soporte consulta las métricas del piloto (Priority: P2)

**Goal**: tablero agregado y sin datos personales con metas del piloto.

**Independent Test**: con datos conocidos, cada cifra coincide con el cálculo manual; sin datos → «sin datos»; sin nombres, correos ni categoría.

### Tests for User Story 3

- [ ] T032 [P] [US3] `tests/unit/signed-timestamp.test.ts`: firma y verificación HMAC con el secreto CSRF de la sesión; firma alterada, secreto distinto o antigüedad mayor a 60 minutos → inválida; hora futura → inválida.
- [ ] T033 [P] [US3] `tests/unit/support-metrics.test.ts`: cálculo de porcentajes, promedio, meta y cumplimiento con `null` para «sin datos» (división por cero), los tres periodos con reloj fijo, y la meta «uso en la semana 4» (médicos activos en esa semana desde la primera aprobación ≥ la mitad).
- [ ] T034 [P] [US3] `tests/integration/support-metrics.test.ts`: con datos conocidos (formularios abiertos y reservas, duraciones dentro y fuera de 2 minutos, firma inválida que cuenta `completed` pero no entra en la duración, correos enviados y fallidos, urgencias `ok` y `rejected` de `calendar_action_log`, citas por médico y semana, acciones de agenda por semana) cada cifra coincide con el cálculo manual; periodo sin datos → «sin datos»; el HTML y el JSON no contienen nombres, correos, teléfonos ni categoría; por médico solo conteos; la apertura del formulario y la reserva incrementan `pilot_metric_daily` de forma atómica con 20 reservas simultáneas (suma exacta).
- [ ] T035 [P] [US3] `tests/contract/support-metrics.test.ts`: `GET /soporte/metricas` con `periodo` válido e inválido (400), roles (403), JSON con las claves del contrato.

### Implementation for User Story 3

- [ ] T036 [US3] Crear `src/lib/signed-timestamp.ts` (`signOpenedAt(secret, now)` y `verifyOpenedAt(secret, token, now)`, HMAC-SHA256 con comparación en tiempo constante, validez de 60 minutos) y `src/modules/site/metrics-hooks.ts` con `recordBookingStarted(executor, doctorId, now)` y `recordBookingCompleted(executor, doctorId, now, durationSeconds | null)` usando `INSERT … ON DUPLICATE KEY UPDATE` (incremento atómico; `under_target_count` si la duración es menor a 120 s).
- [ ] T037 [US3] Integrar en `src/modules/site/patient-routes.ts` y `booking-service.ts`: `GET /c/:slug/reservar` con espacio elegido llama a `recordBookingStarted` y añade el campo oculto firmado `abierto`; el `POST` valida `abierto` (opcional en zod, tolerante a ausencia o firma inválida) y, **después de confirmar la reserva y fuera del bloqueo del calendario**, llama a `recordBookingCompleted` con `try/catch` (una falla del contador se registra con contexto sin datos y **nunca** impide ni deshace una reserva); comentario que documente la elección.
- [ ] T038 [US3] Crear `src/modules/support/metrics-service.ts` con las métricas de `research.md` D5 (correos con `deliveryReport` de `src/mail/delivery-report.ts`, urgencias con `calendar_action_log`, citas por médico y semana con `COUNT(*)`, médicos activos por semana, finalización y tiempo con `pilot_metric_daily`), metas como constantes versionadas y los tres periodos; sin nombres ni correos.
- [ ] T039 [US3] Añadir `GET /soporte/metricas` en `support-routes.ts` y su vista en `support-views.ts` (valor, meta, cumplimiento o «sin datos», selector de periodo), con JSON equivalente.

**Checkpoint**: US1 a US3 funcionan de forma independiente.

---

## Phase 6: User Story 4 - Soporte consulta el historial y todo queda auditado (Priority: P3)

**Goal**: historial de solo lectura filtrable; abrir la cédula deja registro.

**Independent Test**: acciones de dos personas de soporte, lista con filtros y paginación, `view_cedula` registrado, sin forma de editar.

### Tests for User Story 4

- [ ] T040 [P] [US4] Ampliar `tests/integration/support-log.test.ts` y crear `tests/contract/support-history.test.ts`: acciones de dos cuentas aparecen con autor y motivo; filtros por persona, acción y fechas; paginación de 50; `GET /soporte/medicos/:id/cedula` registra `view_cedula` (sin motivo ni contenido) y un 404 no registra nada; ninguna ruta `PUT`, `PATCH` o `DELETE` bajo `/soporte` (recorrer las rutas registradas); intentos directos de `UPDATE`/`DELETE` fallan.

### Implementation for User Story 4

- [ ] T041 [US4] Registrar `view_cedula` en `GET /soporte/medicos/:id/cedula` (`support-routes.ts`) con `appendSupportAction` antes de enviar el archivo; si el registro falla, no se entrega el archivo.
- [ ] T042 [US4] Añadir `GET /soporte/historial` en `support-routes.ts` y su vista en `support-views.ts` (tabla paginada y formulario de filtros `persona`, `accion`, `desde`, `hasta` con zod y `desde ≤ hasta`), con JSON equivalente; enlazar desde el detalle del médico («ver historial de esta cuenta»: filtro por objetivo `doctor`).

**Checkpoint**: US1 a US4 funcionan de forma independiente.

---

## Phase 7: User Story 5 - Liberar una cédula con vista previa de efectos (Priority: P3)

**Goal**: la liberación muestra citas futuras y estado del micrositio antes de confirmar, y deja el micrositio sin reservas.

**Independent Test**: liberar la cédula de un médico con citas futuras y micrositio publicado; ver la advertencia; la cédula puede registrarla otra persona.

### Tests for User Story 5

- [ ] T043 [P] [US5] `tests/integration/support-release.test.ts`: `GET /soporte/medicos/:id/liberar-cedula` muestra el número de citas futuras vigentes y el estado del micrositio sin cambiar nada (la base queda igual); confirmar con motivo libera cédula y móvil, deja la cuenta `rejected`, el micrositio deja de aceptar reservas, el aviso fijo sale sin motivo, otra persona puede registrarse con esa cédula, `account_state` no cambia, y queda `release_cedula` en el historial; sin motivo o sin `confirm` → 400 sin cambios; doble envío → una sola liberación.

### Implementation for User Story 5

- [ ] T044 [US5] Añadir `previewRelease(db, doctorId)` en `src/modules/support/support-service.ts` (`COUNT(*)` de citas futuras vigentes y estado de `doctor_site`) y la pantalla `GET /soporte/medicos/:id/liberar-cedula` en `support-routes.ts`/`support-views.ts`; el `POST` existente exige ahora `confirm = yes` y reutiliza `reasonSchema`; verificar que `isAcceptingBookings` ya rechaza por `approval_status` al quedar `rejected`.

**Checkpoint**: las cinco historias funcionan de forma independiente.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T045 [P] Actualizar `tests/integration/route-audit.test.ts`: añadir `specs/005-panel-de-soporte/contracts/http-routes.md` a `CONTRACT_FILES`, las rutas `/soporte/**` a la lista de rutas con rol de soporte (todas 401/403 sin soporte con doble factor), comprobar que ninguna ruta de soporte toma `doctorId` o `patientId` de un cuerpo que no sea el de la propia acción y que las rutas `GET` de `/soporte` no cambian estado (snapshot de tablas antes y después, incluyendo `support_action_log` salvo `view_cedula`, que se documenta como excepción: es una lectura que se audita por diseño).
- [ ] T046 [P] Crear `docs/decisions/0006-panel-soporte.md` (decisiones de `research.md`, metas del piloto, límites, riesgos: contadores agregados sin personas, solo lectura por método HTTP, `user.status = 'disabled'` como parte de la suspensión, reserva de 90 días, conservación sin plazo hasta la revisión legal, soporte sin datos de pacientes) y actualizar `docs/configuration.md` (migración `0014`, humo de despliegue del panel, sin variables nuevas).
- [ ] T047 [P] Añadir notas en `specs/001-cuentas-y-acceso/contracts/http-routes.md` y `specs/003-micrositio-y-reserva-del-paciente/contracts/http-routes.md` sobre el estado de cuenta, el cierre del supuesto abierto 10 y la reserva del nombre del enlace; marcar el supuesto 10 de `docs/decisions/0001-resumen-grill-me.md` como resuelto con fecha.
- [ ] T048 Ejecutar el conjunto completo (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) por PowerShell con ruta `C:\…` en segundo plano mediante un archivo `.ps1`, sin editar código mientras corre; corregir fallos; comprobar los escenarios 1–24 de `quickstart.md` y la ausencia de `console.log` y de `any` sin justificar.
- [ ] T049 Ejecutar `code-review` y `/security-review` sobre el diff de la feature; verificar cada hallazgo antes de aplicarlo.
- [ ] T050 Validación manual por una persona (no automatizable): recorrido de cada pantalla con una cuenta de soporte real y doble factor, avisos de estado con SMTP real, `npm run migrate` de `0014` y escenarios 4, 8 y 12 en MariaDB de Hostinger, y comparar las métricas de la primera semana del piloto con un conteo manual; cronometrar con una persona de soporte SC-001 (suspender, poner en solo lectura o reactivar en menos de 2 minutos), SC-003 (acceso perdido en menos de 1 minuto) y SC-005 (reintentar un correo en menos de 3 minutos).
- [ ] T051 Dejar `spec.md`, contratos y `checklists/requirements.md` al día con lo implementado y marcar las tareas completadas en este archivo.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: sin dependencias; T001 antes de T002 y T003.
- **Phase 2 (Foundational)**: depende de Phase 1; **bloquea** todas las historias. T004 y T006 antes de T018; T008 antes de T009 y de todas las acciones; T010 antes de T018 y T029.
- **US1 (P1)**: depende de Phase 2. Es el MVP.
- **US2 (P2)**: depende de Phase 2 (y de T018 solo para la lista combinada del detalle). Independiente de US1 en lo demás.
- **US3 (P2)**: depende de Phase 2; toca `patient-routes.ts` y `booking-service.ts`, así que no debe correr en paralelo con tareas que editen esos archivos.
- **US4 (P3)**: depende de Phase 2 (T008). **US5 (P3)**: depende de T009 y T011.
- **Polish (Phase 8)**: depende de las historias que se entreguen.

### Within Each User Story

- Las pruebas se escriben primero y **deben fallar** antes de implementar.
- Servicio → rutas y vistas → integración con otros módulos.
- Tareas que editan el mismo archivo (`support-routes.ts`, `support-views.ts`) van en orden: T022, T031, T039, T041/T042, T044.

### Parallel Opportunities

- Phase 2: T005, T007, T010 y T011 en paralelo (archivos distintos).
- US1: T013 a T017 (pruebas) en paralelo.
- US2: T024 a T026 en paralelo; T027 y T029 en paralelo.
- US3: T032 a T035 en paralelo.
- Polish: T045, T046 y T047 en paralelo.

---

## Implementation Strategy

### MVP primero

1. Phase 1 y Phase 2.
2. **US1**: ciclo de vida de la cuenta con estado aplicado y todas las garantías. Detenerse a validar (escenarios 1 a 9 del quickstart).
3. Entregar de forma incremental: US2 (operación diaria), US3 (métricas del piloto), US4 (historial) y US5 (liberación con vista previa).

### Orden sugerido para una sola persona

T001 → T003 → T002 → Phase 2 → US1 → US2 → US3 → US4 → US5 → Polish. La Feature 4 debe estar cerrada (pruebas completas verdes y T052 manual) antes de empezar, porque esta feature lee la cola de correos y el estado de las urgencias.
