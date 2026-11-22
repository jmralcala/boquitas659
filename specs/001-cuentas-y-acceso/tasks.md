---

description: "Lista de tareas de la feature 001-cuentas-y-acceso"
---

# Tasks: Cuentas y acceso

**Input**: Documentos de diseño en `/specs/001-cuentas-y-acceso/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS. La constitución (principio V) exige pruebas del comportamiento nuevo, escritas antes o junto con la implementación y fallando antes de implementar las reglas de negocio. Cada historia empieza con sus pruebas.

**Organization**: Tareas agrupadas por historia de usuario para implementarlas y probarlas de forma independiente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece (US1 a US6)
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- Sin `any` salvo justificación en comentario; sin `console.log`; sin secretos en código ni tests.
- Toda entrada externa se valida con zod antes de usarse; SQL siempre parametrizado.
- Los registros técnicos nunca incluyen contraseñas, tokens, correos, nombres ni cuerpos de petición.
- Cada tarea termina con `npm run lint && npm run typecheck && npm run test` en verde para lo que toca.
- Commits pequeños, mensaje en imperativo, uno por tarea o grupo lógico.
- No se editan `.env*`, lockfiles (salvo lo que haga `npm install` en T002) ni `secrets/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependencias, scripts y configuración de herramientas.

- [x] T001 Corregir FR-004 en `specs/001-cuentas-y-acceso/spec.md` y su aparición en la historia 1 (escenario 7) y en Assumptions: en México móvil y fijo comparten formato de 10 dígitos desde 2019, así que esta versión solo valida formato mexicano de 10 dígitos y unicidad del móvil de emergencias; que sea realmente móvil se confirma con la verificación por WhatsApp (fase posterior). Ver hallazgo 1 de `research.md`.
- [x] T002 Instalar dependencias en `package.json` con npm, explicando cada una según la tabla "Dependencias nuevas" de `research.md`: `fastify`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart`, `zod`, `mysql2`, `argon2`, `bcryptjs`, `otplib`, `nodemailer`, y de desarrollo `@types/nodemailer` (y los tipos que haga falta). Antes de instalar, comprobar con Context7 versión vigente y mantenimiento de cada paquete y que ningún nombre sea una suplantación. **Aviso**: `npm install` modifica `package-lock.json`; el hook de la plantilla bloquea editar lockfiles con las herramientas de edición, así que si el hook bloquea el comando, pedir al usuario que ejecute `npm install` él mismo y continuar después.
- [x] T003 Añadir scripts a `package.json`: `dev` (`tsc -p tsconfig.build.json && node dist/src/index.js`, sin dependencias de ejecución extra), `migrate` (`node dist/src/db/migrate-cli.js`), `jobs:outbox` (`node dist/src/jobs/outbox.js`), `jobs:cleanup` (`node dist/src/jobs/cleanup.js`), `support:create` (`node dist/scripts/create-support-user.js`), `report:email` (`node dist/scripts/email-delivery-report.js`), `test:integration`; cambiar `build` a `tsc -p tsconfig.build.json` y el campo `main` a `dist/src/index.js`. Como `tsconfig.build.json` compila con `rootDir: "."`, la salida queda en `dist/src` y `dist/scripts`. Conservar los scripts existentes (`test`, `lint`, `typecheck`, `build`, `format`).
- [x] T004 [P] Ajustar `tsconfig.json` y `eslint.config.mjs`: hoy `rootDir` es `src` e `include` solo `["src"]`, por lo que `tests/`, `scripts/` y `migrations/` no se tipan ni se lintean. Cambiar `rootDir` a `.`, incluir `src`, `tests` y `scripts`, y crear `tsconfig.build.json` que compile solo `src` y `scripts` hacia `dist` sin las pruebas; `npm run build` debe usar `tsconfig.build.json`. Mantener `strict: true`. `tsconfig.build.json` debe usar `rootDir: "."` e `include: ["src", "scripts"]`, de modo que la salida quede en `dist/src` y `dist/scripts` (los scripts de T003 dependen de esas rutas).
- [x] T005 [P] Crear `vitest.config.ts` con dos proyectos: `unit` (`tests/unit/**`, `src/**/*.test.ts`) e `integration` (`tests/integration/**`, `tests/contract/**`) que se omite con un aviso claro si falta `TEST_DATABASE_URL`; `npm run test` ejecuta ambos.
- [x] T006 [P] Crear `docs/configuration.md` con todas las variables de entorno de la feature (conexión a la base, `TEST_DATABASE_URL`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, SMTP, `APP_ENV`, directorio privado de cédulas, correo de soporte, URL base pública, `RIGHTS_CONTACT_EMAIL` con valor por defecto `soporte@innvend.com` y `RIGHTS_RESPONSE_DAYS` con valor por defecto `20`; ambos provisionales hasta la revisión legal) con propósito, ejemplo ficticio y si es obligatoria. **No editar `.env.example`** (lo bloquea el hook `.env*`): dejar una nota para que el usuario lo actualice a mano con los nombres de esa lista.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: infraestructura que TODAS las historias necesitan: configuración, base de datos, utilidades, contraseñas, sesiones, CSRF, tokens de un solo uso, correo, núcleo legal y login básico.

**CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

- [x] T007 [P] Escribir `tests/unit/env.test.ts`: el cargador rechaza variables faltantes o inválidas (por ejemplo `APP_ENV` fuera de `development|production`, `SESSION_SECRET` corto) y nunca incluye valores en el mensaje de error.
- [x] T008 Implementar `src/config/env.ts` con esquema zod que lee `process.env` una sola vez y devuelve un objeto tipado inmutable (T007 debe pasar).
- [x] T009 [P] Crear `src/db/pool.ts` (pool de `mysql2` con consultas parametrizadas, zona UTC, `DATETIME(3)`) y `src/db/tx.ts` (helper `withTransaction` con reintento ante `deadlock`).
- [x] T010 [P] Escribir `tests/integration/migrate.test.ts`: aplica migraciones sobre base vacía, es idempotente al repetirse y registra las versiones en `schema_migrations`.
- [x] T011 Implementar `src/db/migrate.ts` y `src/db/migrate-cli.ts`: ejecutor mínimo de archivos SQL numerados en `migrations/` con tabla `schema_migrations` (T010 debe pasar).
- [x] T012 Crear `migrations/0001_core.sql` con las tablas de `data-model.md`: `user` (`email_normalized` único; `role` en `patient`·`doctor`·`reception`·`support`; `status` en `active`·`disabled`; `mfa_enabled`, `mfa_secret_encrypted`), `session` (`token_hash` único), `one_time_token` (`token_hash` único; `purpose` en `password_reset`·`reception_invite`), `login_throttle`, `email_outbox` (`status` en `queued`·`sent`·`failed`), `legal_document` (`type` en `patient_privacy`·`doctor_privacy`·`reception_privacy`·`reception_confidentiality`·`terms_doctor`; único (type, version); `is_provisional`), `consent_acceptance` y `security_event`; más disparadores `BEFORE UPDATE` y `BEFORE DELETE` con `SIGNAL` en `consent_acceptance` (solo anexar).
- [x] T013 Crear `tests/integration/helpers/db.ts`: recrea la base de `TEST_DATABASE_URL`, aplica migraciones, limpia tablas entre pruebas y ofrece fábricas (`createUser` y `createLegalDocs`; `createDoctor` se añade en T050, y `createPatient` y `linkPatientToDoctor` en T066) con un reloj inyectable. Las fábricas dejan aceptaciones vigentes por defecto para que las pruebas de US1 y US2 no choquen con el filtro legal de T100.
- [x] T014 [P] Escribir `tests/unit/normalize.test.ts`: correo (minúsculas, sin espacios, rechaza formato inválido), móvil mexicano (10 dígitos, acepta `+52` y separadores, rechaza otros), cédula (solo dígitos, longitud razonable).
- [x] T015 [P] Escribir `tests/unit/tokens.test.ts`: tokens de 32 bytes en base64url, distintos entre llamadas, hash SHA-256 estable, uso de `crypto.randomBytes` (nunca `Math.random`).
- [x] T016 [P] Escribir `tests/unit/html.test.ts`: la etiqueta de plantilla escapa `< > & " '` en valores interpolados y no escapa el HTML ya marcado como seguro.
- [x] T017 [P] Implementar `src/lib/normalize.ts` (T014 debe pasar).
- [x] T018 [P] Implementar `src/lib/tokens.ts` (T015 debe pasar).
- [x] T019 [P] Implementar `src/lib/html.ts` con la etiqueta `html` que escapa por defecto (T016 debe pasar).
- [x] T020 [P] Crear `src/lib/clock.ts` con la interfaz `Clock` inyectable y una implementación fija para pruebas (para caducidades de sesiones y tokens).
- [x] T021 [P] Escribir `tests/unit/password-hasher.test.ts`: `hash` y `verify` correctos, hashes distintos para la misma contraseña, verificación falla con contraseña errónea, mismo contrato para la implementación argon2id y la de respaldo bcrypt, y `needsRehash`.
- [x] T022 [P] Escribir `tests/unit/password-policy.test.ts`: rechaza menos de 10 caracteres, comunes (lista local), iguales al correo o nombre; acepta 10 o más sin símbolos ni mayúsculas (FR-031); mensajes explican el motivo.
- [x] T023 Implementar `src/modules/auth/password-hasher.ts`: interfaz `PasswordHasher`, implementación argon2id (parámetros calibrables por configuración, objetivo 250 a 500 ms) e implementación de respaldo con `bcryptjs`, elegida por configuración (T021 debe pasar).
- [x] T024 Crear `src/modules/auth/data/common-passwords.txt` (lista de contraseñas más frecuentes; anotar fuente y licencia en un comentario del encabezado de `docs/configuration.md` o de `research.md`, supuesto pendiente) e implementar `src/modules/auth/password-policy.ts` (T022 debe pasar).
- [x] T025 [P] Escribir `tests/unit/logger.test.ts`: la configuración de pino redacta `authorization`, `cookie`, `set-cookie`, y los campos `password`, `token`, `email`; no registra cuerpos de petición.
- [x] T026 Implementar `src/http/logger.ts` con pino y redacción (T025 debe pasar); los errores se registran con código y `userId`, no con correo ni nombre.
- [x] T027 Escribir `tests/unit/app-security.test.ts (sin base de datos, por eso va en unit)` con `fastify.inject`: cabeceras de seguridad presentes, errores 400/404/500 sin trazas ni detalles internos, validación zod devuelve mensajes por campo, límite de tasa responde 429.
- [x] T028 Implementar `src/http/app.ts` (fábrica de Fastify con `@fastify/helmet`, `@fastify/cookie`, `@fastify/rate-limit`, manejador de errores uniforme, identificador de petición), `src/http/validate.ts` (helper que valida body, query y params con zod) y `src/http/errors.ts` (T027 debe pasar).
- [x] T029 Escribir `tests/integration/sessions.test.ts`: sesión nueva válida; caduca por inactividad (30 min personal, 60 min paciente) y por tope absoluto (12 h); revocar corta el acceso; token se guarda solo como hash; se regenera el token al iniciar sesión y al subir de privilegio.
- [x] T030 Implementar `src/modules/auth/sessions.ts` (crear, validar con reloj inyectable, revocar una o todas, rotar, `active_doctor_id` y `mfa_verified` en la sesión) (T029 debe pasar).
- [x] T031 Implementar `src/http/session-plugin.ts`: lee la cookie `__Host-` (`HttpOnly`, `Secure`, `SameSite=Lax`), adjunta `request.auth` y expone guardas `requireAuth` y `requireRole(...roles)` que responden 401/403 según `contracts/http-routes.md`.
- [x] T032 [P] Escribir `tests/contract/csrf.test.ts`: `POST` sin token o con token de otra sesión devuelve 403; token válido pasa; `GET` nunca cambia estado; para páginas sin sesión funciona el token firmado de doble envío.
- [x] T033 Implementar `src/http/csrf.ts` (token sincronizador ligado a la sesión y variante de doble envío firmada para páginas sin sesión) (T032 debe pasar).
- [x] T034 [P] Escribir `tests/integration/one-time-tokens.test.ts`: `peek` no consume; `consume` solo funciona una vez; vencido se rechaza (30 min recuperación, 7 días invitación); dos `consume` simultáneos: exactamente uno gana; solo se guarda el hash.
- [x] T035 Implementar `src/modules/auth/one-time-tokens.ts` con `create`, `peek` y `consume` atómico (`UPDATE ... WHERE used_at IS NULL AND expires_at > ?`) (T034 debe pasar). `create` invalida los tokens vigentes del mismo propósito y sujeto, de modo que solo exista un enlace válido por solicitud.
- [x] T036 [P] Escribir `tests/integration/outbox.test.ts`: encolar, procesar con transporte en memoria, reintentos con espera creciente, estado `failed` tras agotar intentos sin guardar el cuerpo, procesamiento idempotente si el cron se solapa. Incluir un caso: un reintento de envío de una plantilla con enlace no deja dos tokens vigentes y el cuerpo enviado no se guarda.
- [x] T037 Implementar `src/mail/outbox.ts` (encolar con `payload_ref` de identificadores), `src/mail/templates.ts` (registro de plantillas en español, sin datos personales en el asunto), `src/mail/transport.ts` (interfaz con `nodemailer` por SMTP y una versión en memoria para pruebas) y `src/jobs/outbox.ts` (T036 debe pasar). Las plantillas con enlace (`password_reset`, `reception_invitation`) crean su token de un solo uso dentro del procesador, en la misma transacción que marca el correo como enviado; el token nunca se guarda en claro y su caducidad (30 minutos o 7 días) cuenta desde el envío.
- [x] T038 [P] Escribir `tests/integration/legal-core.test.ts`: publicar versión nueva de un documento, obtener la última versión, registrar aceptación con quién, documento, versión y cuándo, y `UPDATE` o `DELETE` sobre `consent_acceptance` falla por el disparador.
- [x] T039 Implementar `src/modules/legal/legal-service.ts` (publicar, última versión por tipo, `recordAcceptance`, `hasAcceptedLatest`) y `src/modules/legal/seed-provisional.ts` con textos provisionales marcados `is_provisional` para los 5 tipos (T038 debe pasar).
- [x] T040 [P] Crear `src/lib/tenant.ts` con el tipo `TenantContext` (`{ doctorId, actor }`) y un constructor que solo se puede invocar tras comprobar la relación; documentar que ninguna función de lectura de pacientes existe sin este tipo (principio II).
- [x] T041 [P] Crear `src/http/views/layout.ts` y `src/http/views/forms.ts`: plantilla base en español con pie que enlaza `/legal` y `/derechos`, y ayudantes de formulario que incluyen el token CSRF y las casillas de aceptación sin marcar de antemano, usando `src/lib/html.ts`.
- [ ] T042 [P] Escribir `tests/contract/login.test.ts`: login correcto redirige al panel del rol; correo inexistente y contraseña incorrecta devuelven el mismo mensaje y tiempos comparables; logout revoca la sesión; la cuenta con `status = disabled` no entra.
- [ ] T043 Implementar `src/modules/auth/routes.ts` y vistas (`GET/POST /login`, `POST /logout`): hash ficticio ante correo inexistente, mensaje uniforme, sesión nueva con rotación de token (T042 debe pasar). Sin límite de intentos todavía (llega en US3) ni segundo factor (US6).
- [ ] T044 Reescribir `src/index.ts` para arrancar el servidor (leer configuración, abrir el pool, registrar módulos, escuchar); conservar o actualizar `src/index.test.ts` para que `npm run test` siga en verde (si `saludar` se elimina, retirar también su prueba).

**Checkpoint**: la base está lista; las historias pueden empezar.

---

## Phase 3: User Story 1 - Médico se registra y soporte aprueba su cuenta (Priority: P1) MVP

**Goal**: un médico se registra con cédula y móvil de emergencias, soporte revisa y aprueba o rechaza, y la prueba de 5 días empieza al aprobar.

**Independent Test**: registrar un médico, comprobar que no accede a funciones, aprobarlo como soporte y comprobar acceso y prueba iniciada (quickstart escenarios 1 a 4 y recorrido manual pasos 1 y 2).

### Tests for User Story 1 (escribir primero; deben fallar)

- [ ] T045 [P] [US1] Escribir `tests/contract/doctor-registration.test.ts`: sin `acceptPrivacy` y `acceptTerms` el registro devuelve 400; con ambas crea cuenta `pending`, registra dos aceptaciones y encola `support_new_doctor` sin adjuntos; cédula duplicada y móvil duplicado devuelven 400 que remite a soporte; móvil con formato inválido devuelve 400. Incluir un caso: un correo ya registrado con otro rol se rechaza con un mensaje genérico que no revela el rol de la cuenta existente.
- [ ] T046 [P] [US1] Escribir `tests/unit/cedula-file.test.ts`: acepta JPEG, PNG y PDF por firma de bytes aunque la extensión o `Content-Type` mientan; rechaza otros tipos y archivos de más de 5 MB; el nombre en disco es aleatorio; una ruta con `..` nunca sale del directorio privado.
- [ ] T047 [P] [US1] Escribir `tests/integration/doctor-approval.test.ts`: `pending → approved` fija `approved_at`, `approved_by_user_id`, `trial_started_at` y `trial_ends_at` (5 días después) y encola `doctor_approved`; `pending → rejected` exige `reason`; `rejected → pending` por reenvío; `approved` no vuelve atrás; cada transición escribe en `doctor_review`.
- [ ] T048 [P] [US1] Escribir `tests/integration/doctor-gating.test.ts`: un médico `pending` o `rejected` se autentica pero solo ve `/medicos/estado`; cualquier ruta que exija médico aprobado responde 403.
- [ ] T049 [P] [US1] Escribir `tests/contract/support-review.test.ts`: las rutas `/soporte/*` solo admiten rol `support`; rechazar sin motivo devuelve 400; `liberar-cedula` pone `NULL` en cédula y móvil y permite registrar de nuevo esos datos; la ruta de la cédula entrega el archivo con `Content-Disposition` y `X-Content-Type-Options: nosniff`.

### Implementation for User Story 1

- [ ] T050 [US1] Crear `migrations/0002_doctors.sql` con `doctor` (`user_id` único; `cedula_normalized` único mientras no esté liberada y `NULL` al liberarla; `emergency_mobile` único y `NULL` al liberarlo; `approval_status` en `pending`·`approved`·`rejected`; `rejection_reason`; `approved_at`, `approved_by_user_id`, `trial_started_at`, `trial_ends_at`; `cedula_file_path`, `cedula_file_sha256`; `office_phone` opcional) y `doctor_review` (`decision` en `approved`·`rejected`·`cedula_released`). Extender `tests/integration/helpers/db.ts` con la fábrica `createDoctor`.
- [ ] T051 [P] [US1] Implementar `src/modules/doctors/cedula-storage.ts`: valida firma de bytes y 5 MB, guarda con nombre aleatorio en el directorio privado de la configuración, calcula SHA-256 y nunca construye rutas con entrada del usuario (T046 debe pasar).
- [ ] T052 [P] [US1] Implementar `src/modules/doctors/doctor-repository.ts` con SQL parametrizado: crear, buscar por usuario, cambiar estado, liberar cédula, listar por estado, escribir `doctor_review`.
- [ ] T053 [US1] Implementar `src/modules/doctors/registration-service.ts`: valida con zod (nombre, correo, contraseña con la política, cédula, móvil de 10 dígitos, teléfono opcional), crea `user` y `doctor` en una transacción, registra las aceptaciones de `doctor_privacy` y `terms_doctor` en su versión vigente antes de guardar la cédula, y encola `support_new_doctor`; traduce la violación de índice único a un error de negocio sin revelar de quién es la cédula. Antes de crear, comprueba si el correo ya existe con otro rol y lo rechaza con un mensaje genérico que no revela el rol.
- [ ] T054 [US1] Implementar `src/modules/doctors/registration-routes.ts` y vistas (`GET/POST /medicos/registro`, multipart con límite de 5 MB, casillas sin marcar) (T045 debe pasar).
- [ ] T055 [US1] Implementar `src/modules/doctors/status-routes.ts` (`GET /medicos/estado`, `POST /medicos/estado/reenviar` solo con estado `rejected`) y vistas.
- [ ] T056 [US1] Implementar la guarda `requireApprovedDoctor` y la variante que permite `pending` o `rejected` solo en `/medicos/estado` en `src/http/session-plugin.ts` o `src/modules/doctors/guards.ts`, y `GET /medicos/panel` mínimo (T048 debe pasar).
- [ ] T057 [P] [US1] Crear `scripts/create-support-user.ts`: pide correo y contraseña por entrada estándar (sin eco, nunca por argumentos), aplica la política de contraseñas, crea `user` con rol `support` y deja el alta de TOTP pendiente para US6.
- [ ] T058 [US1] Implementar `src/modules/support/support-service.ts` (listar pendientes, ver, aprobar, rechazar con motivo, liberar cédula; cada decisión registra quién, cuándo y motivo en `doctor_review`; aprobar fija la prueba de 5 días y encola `doctor_approved`) (T047 debe pasar).
- [ ] T059 [US1] Implementar `src/modules/support/support-routes.ts` y vistas mínimas (`GET /soporte/medicos`, `GET /soporte/medicos/:id`, `GET /soporte/medicos/:id/cedula`, `POST .../aprobar`, `.../rechazar`, `.../liberar-cedula`) con `requireRole('support')` y CSRF (T049 debe pasar).
- [ ] T060 [P] [US1] Añadir a `src/mail/templates.ts` las plantillas `support_new_doctor` (a `soporte@innvend.com` sin adjuntos y con enlace a `/soporte/medicos/:id`), `doctor_approved` y `doctor_rejected` según `contracts/email-notifications.md`.
- [ ] T061 [US1] Registrar los módulos de esta historia en `src/http/app.ts` y ejecutar los escenarios 1 a 4 y 29 de `quickstart.md`.

**Checkpoint**: US1 funciona y se prueba sola. **Aviso**: las rutas `/soporte/*` no deben exponerse en producción hasta completar el segundo factor obligatorio (T109); mientras tanto solo en desarrollo.

---

## Phase 4: User Story 2 - Paciente crea su cuenta global y consiente el aviso de privacidad (Priority: P1)

**Goal**: cuenta global del paciente con consentimiento, menores bajo el tutor y aislamiento por médico.

**Independent Test**: crear paciente, añadir un menor, verificar aceptaciones y que el médico B no obtiene al paciente del médico A (quickstart escenarios 5 a 7).

### Tests for User Story 2

- [ ] T062 [P] [US2] Escribir `tests/contract/patient-registration.test.ts`: sin `acceptPrivacy` devuelve 400; con él crea cuenta, paciente y aceptación (quién, documento, versión, cuándo); correo existente indica iniciar sesión y respeta el límite de peticiones; se guarda `birth_date` y no la edad. Incluir un caso: un correo ya registrado con otro rol se rechaza con un mensaje genérico que no revela el rol de la cuenta existente.
- [ ] T063 [P] [US2] Escribir `tests/contract/patient-dependents.test.ts`: el tutor añade un menor con `acceptPrivacyOnBehalf`, que crea un `patient` con `account_id` del tutor y una aceptación con `on_behalf_of_patient_id`; sin la casilla devuelve 400; otro usuario no puede añadir menores a una cuenta ajena.
- [ ] T064 [P] [US2] Escribir `tests/integration/tenant-isolation.test.ts`: con dos médicos y un paciente vinculado solo al médico A, las funciones de repositorio con `TenantContext` del médico B no devuelven al paciente ni por id ni por listado; un paciente vinculado a A y B es visible para ambos; sin vínculo no hay acceso.
- [ ] T065 [P] [US2] Escribir `tests/unit/age.test.ts`: la edad se calcula a partir de `birth_date`, incluidos cumpleaños, 29 de febrero y fechas futuras (rechazadas).

### Implementation for User Story 2

- [ ] T066 [US2] Crear `migrations/0003_patients.sql` con `patient_account` (`user_id` único; `phone`), `patient` (`account_id`; `full_name`; `birth_date` como fecha; `email` opcional para menores; `phone`; `is_minor_dependent`) y `doctor_patient` (único (`doctor_id`, `patient_id`)). Sin campos de historial clínico ni de triaje. Extender `tests/integration/helpers/db.ts` con las fábricas `createPatient` y `linkPatientToDoctor`.
- [ ] T067 [P] [US2] Implementar `src/lib/age.ts` (T065 debe pasar).
- [ ] T068 [P] [US2] Implementar `src/modules/patients/patient-repository.ts`: funciones de cuenta y de pacientes por cuenta, y funciones de lectura por médico que exigen `TenantContext` como primer parámetro y filtran siempre por `doctor_id` mediante `doctor_patient` (T064 debe pasar). No exportar ninguna lectura de pacientes sin ese contexto.
- [ ] T069 [US2] Implementar `src/modules/patients/registration-service.ts`: valida con zod, aplica la política de contraseñas, crea `user`, `patient_account` y `patient` en una transacción, registra la aceptación de `patient_privacy` y responde a un correo existente indicando iniciar sesión. Antes de crear, comprueba si el correo ya existe con otro rol y lo rechaza con un mensaje genérico que no revela el rol.
- [ ] T070 [US2] Implementar `src/modules/patients/dependents-service.ts` (alta de paciente adicional con aceptación en nombre del menor) y `src/modules/patients/link-service.ts` con `linkPatientToDoctor` (uso interno; la reserva lo invocará en la feature 3).
- [ ] T071 [US2] Implementar `src/modules/patients/routes.ts` y vistas (`GET/POST /pacientes/registro`, `GET /pacientes/panel`, `POST /pacientes/adicionales`) con límite de peticiones en el alta (T062 y T063 deben pasar).
- [ ] T072 [US2] Registrar el módulo en `src/http/app.ts` y ejecutar los escenarios 5 a 7 de `quickstart.md`.

**Checkpoint**: US1 y US2 funcionan de forma independiente.

---

## Phase 5: User Story 3 - Inicio de sesión seguro y recuperación de contraseña (Priority: P1)

**Goal**: límite de intentos con espera creciente, recuperación por correo, aviso de dispositivo nuevo y cambios sensibles con contraseña.

**Independent Test**: contraseñas débiles, fallos repetidos, caducidad por inactividad y enlace de recuperación válido, usado y vencido (quickstart escenarios 8 a 14).

### Tests for User Story 3

- [ ] T073 [P] [US3] Escribir `tests/integration/login-throttle.test.ts`: cada fallo aumenta la espera (1, 2, 4 ... hasta un máximo configurable) por cuenta y por IP; el éxito reinicia el contador de la cuenta; la respuesta no distingue correo inexistente de contraseña incorrecta; el estado se guarda en base de datos y sin correo en claro.
- [ ] T074 [P] [US3] Escribir `tests/contract/password-recovery.test.ts`: `POST /recuperar` responde igual exista o no la cuenta y solo encola correo si existe; `GET /recuperar/:token` no consume; `POST` con token válido cambia la contraseña, aplica la política, revoca las demás sesiones, encola `password_changed`; token usado o vencido (30 minutos) se rechaza.
- [ ] T075 [P] [US3] Escribir `tests/integration/new-device.test.ts`: un inicio de sesión sin cookie de dispositivo conocida registra el dispositivo, escribe `security_event` y encola `new_device_login`; con cookie conocida no se envía; solo se guarda el hash del identificador.
- [ ] T076 [P] [US3] Escribir `tests/contract/sensitive-changes.test.ts`: cambiar contraseña o correo exige la contraseña actual; cambiar correo avisa al anterior (`email_changed_old`) y al nuevo (`email_changed_new`); contraseña actual incorrecta devuelve 403 y cuenta como intento fallido. Incluir también: cambiar el móvil de emergencias exige la contraseña actual, un móvil duplicado devuelve 400 y escribe `security_event` `emergency_mobile_changed`; el cambio de contraseña autenticado revoca las demás sesiones.

### Implementation for User Story 3

- [ ] T077 [US3] Crear `migrations/0004_security.sql` con `trusted_device` (`user_id`, `device_hash`, `first_seen_at`, `last_seen_at`).
- [ ] T078 [US3] Implementar `src/modules/auth/login-throttle.ts` y conectarlo a `POST /login` (T073 debe pasar), con el hash ficticio para igualar tiempos.
- [ ] T079 [P] [US3] Implementar `src/modules/auth/devices.ts` (cookie de dispositivo de larga vida, hash por usuario, detección de dispositivo nuevo) y `src/modules/auth/security-events.ts` (T075 debe pasar).
- [ ] T080 [US3] Implementar `src/modules/auth/recovery-routes.ts` y vistas (`GET/POST /recuperar`, `GET/POST /recuperar/:token`) con límite de peticiones por IP y token de un solo uso de 30 min (T074 debe pasar).
- [ ] T081 [US3] Implementar `src/modules/auth/account-routes.ts` y vistas (`GET/POST /cuenta/contrasena`, `GET/POST /cuenta/correo`) con reautenticación por contraseña actual (T076 debe pasar). El cambio de contraseña revoca todas las demás sesiones del usuario y conserva la actual.
- [ ] T082 [US3] Implementar `GET/POST /cuenta/movil-emergencia` en `src/modules/doctors/account-routes.ts` y vistas: exige la contraseña actual, valida formato mexicano de 10 dígitos y unicidad (`emergency_mobile` único), deja el móvil nuevo sin verificar hasta la fase con WhatsApp, escribe `security_event` `emergency_mobile_changed` y encola la plantilla `emergency_mobile_changed` al correo del médico (T076 debe pasar).
- [ ] T083 [P] [US3] Añadir las plantillas `password_reset`, `password_changed`, `new_device_login`, `email_changed_old`, `email_changed_new` y `emergency_mobile_changed` a `src/mail/templates.ts` según `contracts/email-notifications.md`.
- [ ] T084 [US3] Ejecutar los escenarios 8 a 14, 28 y 30 de `quickstart.md` y el paso 5 del recorrido manual.

**Checkpoint**: US1, US2 y US3 funcionan de forma independiente.

---

## Phase 6: User Story 4 - Médico invita a recepción y controla su acceso (Priority: P2)

**Goal**: invitaciones por correo con límite de 2, permisos de recepción acotados, retiro inmediato y vínculo con varios médicos.

**Independent Test**: invitar, aceptar, probar permisos permitidos y prohibidos, retirar y verificar corte inmediato (quickstart escenarios 15 a 20).

### Tests for User Story 4

- [ ] T085 [P] [US4] Escribir `tests/integration/reception-limit.test.ts`: con 2 entre pendientes y activas, una tercera invitación se rechaza; con invitaciones simultáneas (varias peticiones a la vez) nunca se supera 2 (transacción que bloquea la fila del médico); revocar o retirar libera un lugar.
- [ ] T086 [P] [US4] Escribir `tests/contract/reception-invitation.test.ts`: `GET /recepcion/invitacion/:token` no consume; `POST` exige `acceptPrivacy` y `acceptConfidentiality`, consume el token y crea el vínculo; token ya usado o vencido (7 días) se rechaza; una cuenta nueva exige contraseña con la política y una cuenta de recepción existente no. Incluir un caso: un correo ya registrado con otro rol se rechaza con un mensaje genérico que no revela el rol de la cuenta existente.
- [ ] T087 [P] [US4] Escribir `tests/contract/reception-permissions.test.ts`: recepción recibe 403 en configuración, pagos, móvil de emergencias, cédula e invitar; sí puede ver el panel y los datos de contacto de los pacientes del médico activo.
- [ ] T088 [P] [US4] Escribir `tests/integration/reception-revocation.test.ts`: tras retirar el vínculo, la siguiente petición de una sesión abierta responde 401 o 403 sin esperar a que caduque; una persona con dos médicos solo ve datos del médico activo y no puede activar uno sin vínculo vigente; cada acción escribe `reception_action_log`.

### Implementation for User Story 4

- [ ] T089 [US4] Crear `migrations/0005_reception.sql` con `reception_invitation` (`status` en `pending`·`accepted`·`expired`·`revoked`; `expires_at` a 7 días; `email_normalized`), `reception_membership` (único (`doctor_id`, `reception_user_id`) para el vínculo vigente; `revoked_at`) y `reception_action_log`.
- [ ] T090 [P] [US4] Implementar `src/modules/reception/reception-repository.ts` con SQL parametrizado.
- [ ] T091 [US4] Implementar `src/modules/reception/invitation-service.ts`: invitar (transacción con bloqueo de la fila del médico y conteo de pendientes más activas), revocar, aceptar (consume el token, crea el vínculo, registra las aceptaciones de `reception_privacy` y `reception_confidentiality`, encola `reception_joined`) (T085 y T086 deben pasar). Antes de invitar, comprueba si el correo ya existe con otro rol y lo rechaza con un mensaje genérico que no revela el rol. Escribe `reception_action_log` (`action`: `invite`, `accept`, `revoke_invitation`) con el usuario y el médico.
- [ ] T092 [US4] Implementar `src/modules/reception/membership-service.ts`: retirar (marca `revoked_at`, revoca las sesiones de esa persona con ese médico, encola `reception_removed`), listar vínculos vigentes y elegir médico activo solo entre vínculos vigentes. Escribe `reception_action_log` (`action`: `remove`, `select_active_doctor`) con el usuario y el médico.
- [ ] T093 [US4] Extender `src/modules/auth/sessions.ts` y `src/http/session-plugin.ts` para revalidar en cada petición que el vínculo de recepción con `active_doctor_id` siga vigente y construir el `TenantContext` solo tras esa comprobación (T088 debe pasar).
- [ ] T094 [US4] Implementar `src/modules/reception/routes.ts` y vistas (`GET /medicos/recepcion`, `POST /medicos/recepcion/invitar`, `POST .../:membershipId/retirar`, `POST .../invitaciones/:id/revocar`, `GET/POST /recepcion/invitacion/:token`, `GET/POST /recepcion/medico-activo`, `GET /recepcion/panel`) con la guarda de permisos de recepción (T087 debe pasar).
- [ ] T095 [P] [US4] Añadir las plantillas `reception_invitation`, `reception_joined` y `reception_removed` a `src/mail/templates.ts`.
- [ ] T096 [US4] Registrar el módulo en `src/http/app.ts` y ejecutar los escenarios 15 a 20 de `quickstart.md` y el paso 3 del recorrido manual.

**Checkpoint**: US1 a US4 funcionan de forma independiente.

---

## Phase 7: User Story 5 - Aviso de privacidad versionado y siempre accesible (Priority: P2)

**Goal**: reaceptación obligatoria al cambiar de versión, textos públicos, canal de derechos y bloqueo de textos provisionales en producción.

**Independent Test**: publicar una versión nueva y comprobar que el usuario debe aceptarla (quickstart escenarios 21 a 23).

### Tests for User Story 5

- [ ] T097 [P] [US5] Escribir `tests/contract/legal-gate.test.ts`: tras publicar una versión nueva, cualquier ruta autenticada responde 403 con redirección a `/legal/aceptar` hasta aceptar todas las versiones vigentes que aplican al rol; `POST /legal/aceptar` escribe `consent_acceptance`; casillas sin marcar bloquean.
- [ ] T098 [P] [US5] Escribir `tests/contract/legal-public.test.ts`: `/legal`, `/legal/:type`, `/legal/:type/v/:version` y `/derechos` son accesibles sin sesión; `type` fuera de la lista cerrada devuelve 404; el pie de las páginas públicas enlaza el aviso.
- [ ] T099 [P] [US5] Escribir `tests/integration/provisional-block.test.ts`: con `APP_ENV=production` y el aviso correspondiente marcado `is_provisional`, devuelven 403 el alta de pacientes (`patient_privacy`), el registro de médicos (`doctor_privacy` o `terms_doctor`) y la aceptación de invitaciones de recepción (`reception_privacy` o `reception_confidentiality`); en `development` se permiten; al publicar una versión revisada se permiten.

### Implementation for User Story 5

- [ ] T100 [US5] Implementar `src/modules/legal/legal-gate.ts` y conectarlo como gancho global en `src/http/app.ts`: calcula los documentos aplicables al rol (por ejemplo paciente: `patient_privacy`; médico: `doctor_privacy` y `terms_doctor`; recepción: `reception_privacy` y `reception_confidentiality`) y bloquea hasta aceptar la última versión (T097 debe pasar).
- [ ] T101 [US5] Implementar `src/modules/legal/routes.ts` y vistas (`GET /legal`, `GET /legal/:type`, `GET /legal/:type/v/:version`, `GET/POST /legal/aceptar`, `GET /derechos`) con el canal y el plazo de respuesta para derechos de acceso, rectificación, cancelación y oposición tomados de la configuración (T098 debe pasar). `/derechos` muestra el correo de `RIGHTS_CONTACT_EMAIL` y el plazo de `RIGHTS_RESPONSE_DAYS` de la configuración.
- [ ] T102 [US5] Implementar el bloqueo por documento provisional en `src/modules/patients/registration-service.ts`, `src/modules/doctors/registration-service.ts` y `src/modules/reception/invitation-service.ts` usando `APP_ENV` (T099 debe pasar).
- [ ] T103 [US5] Crear `scripts/publish-legal-document.ts` (publica una versión nueva de un tipo desde un archivo, con marca provisional o revisada) y documentar en `docs/configuration.md` el procedimiento para sustituir los textos provisionales por los revisados por el abogado.
- [ ] T104 [US5] Ejecutar los escenarios 21 a 23 de `quickstart.md`.

**Checkpoint**: US1 a US5 funcionan de forma independiente.

---

## Phase 8: User Story 6 - Doble factor y registro de accesos a datos de pacientes (Priority: P3)

**Goal**: TOTP obligatorio para soporte y opcional para médicos y recepción; registro de solo anexar de accesos a pacientes.

**Independent Test**: soporte sin TOTP queda obligado a configurarlo; abrir el detalle de un paciente escribe el registro (quickstart escenarios 24 a 27).

### Tests for User Story 6

- [ ] T105 [P] [US6] Escribir `tests/unit/totp.test.ts`: genera y verifica códigos con ventana limitada, rechaza reutilización del mismo código y cifra el secreto en reposo con AES-256-GCM y `MFA_ENCRYPTION_KEY` (nunca en claro).
- [ ] T106 [P] [US6] Escribir `tests/contract/mfa.test.ts`: activar TOTP exige confirmar un código y entrega 10 códigos de recuperación una sola vez (guardados como hash, de un solo uso); con TOTP activo el login pide `/login/mfa`; un código de recuperación usado no vuelve a servir; desactivar exige contraseña y avisa por correo.
- [ ] T107 [P] [US6] Escribir `tests/contract/support-mfa-enforcement.test.ts`: soporte sin TOTP configurado solo puede llegar a `/cuenta/mfa/alta` y el resto de rutas devuelve 403; con TOTP pero sin verificar en la sesión no accede a `/soporte/*`.
- [ ] T108 [P] [US6] Escribir `tests/contract/patient-detail-audit.test.ts` y `tests/integration/patient-access-log.test.ts`: `GET /agenda/pacientes/:patientId` devuelve nombre, teléfono, correo, edad calculada y tutor si es menor solo con vínculo médico-paciente; sin vínculo responde 404; cada apertura, permitida o denegada, escribe `patient_access_log` con actor, médico, paciente y resultado y sin contenido; `UPDATE` y `DELETE` sobre esa tabla fallan; recepción accede solo con su médico activo.

### Implementation for User Story 6

- [ ] T109 [US6] Crear `migrations/0006_mfa_audit.sql` con `mfa_recovery_code` (`user_id`, `code_hash`, `used_at`; 10 por usuario), `patient_access_log` (`outcome` en `allowed`·`denied`; sin contenido del paciente) con disparadores `BEFORE UPDATE` y `BEFORE DELETE` con `SIGNAL`, y los índices necesarios.
- [ ] T110 [P] [US6] Implementar `src/modules/auth/totp.ts` (otplib, cifrado AES-256-GCM del secreto, 10 códigos de recuperación de un solo uso) (T105 debe pasar). Comparar los códigos TOTP y de recuperación con `crypto.timingSafeEqual` (comparación en tiempo constante, guía de seguridad).
- [ ] T111 [US6] Implementar `src/modules/auth/mfa-routes.ts` y vistas (`GET/POST /login/mfa`, `GET/POST /cuenta/mfa`, `GET/POST /cuenta/mfa/alta`), el paso de rotación de sesión a `mfa_verified` y los correos `mfa_enabled` y `mfa_disabled` (T106 debe pasar).
- [ ] T112 [US6] Implementar la guarda `requireSupportMfa` en `src/http/session-plugin.ts` y aplicarla a todas las rutas `/soporte/*` y al resto de rutas de soporte (T107 debe pasar); actualizar `scripts/create-support-user.ts` para que el primer acceso obligue al alta de TOTP.
- [ ] T113 [P] [US6] Implementar `src/modules/audit/access-log.ts` (escribir `patient_access_log` con actor, rol, médico, paciente y resultado, sin contenido; los intentos denegados también se registran).
- [ ] T114 [US6] Implementar `GET /agenda/pacientes/:patientId` en `src/modules/patients/detail-routes.ts` con vista: obtiene el `TenantContext`, consulta con el repositorio de US2, registra el acceso antes de responder y devuelve 404 sin distinguir inexistente de ajeno (T108 debe pasar).
- [ ] T115 [US6] Ejecutar los escenarios 24 a 27 de `quickstart.md` y el paso 4 del recorrido manual.

**Checkpoint**: las 6 historias funcionan de forma independiente.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: cierre de calidad, seguridad y despliegue.

- [ ] T116 [P] Implementar `src/jobs/cleanup.ts` (borra tokens vencidos, sesiones vencidas, correos entregados antiguos y filas de `login_throttle` viejas, de forma idempotente) con `tests/integration/cleanup.test.ts`.
- [ ] T117 [P] Crear `scripts/email-delivery-report.ts` (`npm run report:email`) que cuente los correos del outbox por plantilla y estado (`sent`, `failed`) en un periodo y calcule el porcentaje entregado para la meta de SC-010 (más de 98 %), sin direcciones ni contenido, con `tests/integration/email-delivery-report.test.ts`.
- [ ] T118 [P] Escribir `tests/integration/log-redaction.test.ts` (escenario 26): ejecuta los flujos principales con un registro capturado y comprueba que no aparecen contraseñas, tokens, correos, nombres ni cuerpos de petición.
- [ ] T119 [P] Escribir `tests/integration/append-only.test.ts` (escenario 27) que consolide las comprobaciones de disparadores de `consent_acceptance` y `patient_access_log`.
- [ ] T120 Revisar que toda ruta de `contracts/http-routes.md` tenga esquema zod, guarda de rol y CSRF donde cambia estado, y que ninguna consulta de datos de pacientes carezca de `TenantContext`; corregir lo que falte.
- [ ] T121 Buscar y eliminar `console.log` y secretos en `src`, `tests` y `scripts` (`rg "console\.log"`).
- [ ] T122 Ejecutar `npm run lint`, `npm run typecheck`, `npm run test` y `npm run build`; todos deben pasar.
- [ ] T123 Ejecutar la validación completa de `quickstart.md` (los 30 escenarios y el recorrido manual).
- [ ] T124 Documentar en `docs/decisions/0002-cuentas-y-acceso.md` las decisiones técnicas (respaldo bcrypt, sesiones en base de datos, outbox con cron, corrección de FR-004) y actualizar `spec.md` para reflejar lo implementado, como exige la definición de terminado.
- [ ] T125 Preparar y documentar en `docs/configuration.md` el humo de despliegue en Hostinger: carga de `argon2`, latencia real del cron de un minuto con `jobs:outbox`, SPF/DKIM/DMARC y límites de envío del SMTP, y directorio de cédulas fuera de la raíz pública (resultados quedan como pendientes hasta desplegar).
- [ ] T126 Ejecutar `code-review` sobre el diff y `/security-review` antes del PR, y corregir los hallazgos.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias; T002 y T003 antes de cualquier código.
- **Foundational (Phase 2)**: depende de Setup y bloquea todas las historias.
- **Historias (Phases 3 a 8)**: dependen de Foundational. Orden por prioridad: US1, US2, US3 (P1), US4, US5 (P2), US6 (P3).
- **Polish (Phase 9)**: depende de las historias deseadas.

### User Story Dependencies

- **US1** (P1): tras Foundational. Usa login básico (T043), legal core (T039), outbox (T037) y sesiones.
- **US2** (P1): tras Foundational; independiente de US1 salvo que `doctor_patient` referencia a `doctor` (migración 0002), por lo que **requiere T050**.
- **US3** (P1): tras Foundational; extiende el login (T043). Independiente de US1 y US2.
- **US4** (P2): requiere médicos aprobados (US1: T050, T056) y extiende sesiones (T093).
- **US5** (P2): tras Foundational; la prueba del bloqueo provisional requiere el alta de pacientes (US2: T071).
- **US6** (P3): requiere US2 (repositorio de pacientes, T068) y US4 (contexto de recepción, T093) para el detalle; el TOTP solo depende de Foundational. **Las rutas de soporte de US1 no se exponen en producción antes de T112.**

### Within Each User Story

- Pruebas primero y fallando; después migración, repositorios, servicios, rutas, plantillas de correo, registro en `app.ts` y validación con el quickstart.
- Las migraciones se numeran 0001 a 0006 en el orden de las fases; no crear migraciones fuera de esa numeración sin renumerar.

### Parallel Opportunities

- En Setup: T004, T005 y T006.
- En Foundational: las pruebas y utilidades de `src/lib` (T014 a T020), contraseñas (T021 y T022), logger (T025), CSRF (T032), tokens (T034), outbox (T036), legal (T038), `tenant.ts` y vistas (T040 y T041).
- Las pruebas de cada historia entre sí (todas marcadas `[P]`).
- Tras Foundational, US1, US3 y US5 pueden avanzar en paralelo (archivos distintos); US2 espera la migración de US1.

---

## Parallel Example: User Story 1

```text
# Pruebas de la historia (a la vez):
Task: "T045 tests/contract/doctor-registration.test.ts"
Task: "T046 tests/unit/cedula-file.test.ts"
Task: "T047 tests/integration/doctor-approval.test.ts"
Task: "T048 tests/integration/doctor-gating.test.ts"
Task: "T049 tests/contract/support-review.test.ts"

# Implementación independiente entre sí:
Task: "T051 src/modules/doctors/cedula-storage.ts"
Task: "T052 src/modules/doctors/doctor-repository.ts"
Task: "T057 scripts/create-support-user.ts"
Task: "T060 plantillas de correo de médicos"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Completar Phase 1 y Phase 2.
2. Completar Phase 3 (US1).
3. **Detenerse y validar**: registrar un médico, aprobarlo como soporte, comprobar la prueba de 5 días.
4. Solo en desarrollo: sin US6 no hay segundo factor para soporte.

### Incremental Delivery

1. Setup + Foundational.
2. US1, US2 y US3 (todas P1): es el mínimo para que haya médicos, pacientes y cuentas seguras.
3. US4 (recepción) y US5 (reaceptación y textos públicos), ambas P2.
4. US6 (doble factor y auditoría), que debe estar antes de exponer soporte en producción.
5. Polish y revisiones previas al PR.

### Entrada al piloto (criterio)

Antes de que entre un paciente real: T102 y T103 completos, textos legales revisados por un abogado y publicados sin marca provisional, T112 completo y el humo de despliegue (T125) ejecutado.

---

## Notes

- `[P]` = archivos distintos y sin dependencias pendientes.
- La etiqueta `[Story]` da trazabilidad de cada tarea a su historia.
- Verificar que las pruebas fallen antes de implementar las reglas de negocio.
- Commit tras cada tarea o grupo lógico.
- Cualquier decisión técnica nueva o desviación del plan se anota en `research.md` y se refleja en `spec.md` al terminar.
