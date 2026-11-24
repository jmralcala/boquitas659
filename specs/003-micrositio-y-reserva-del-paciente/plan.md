# Implementation Plan: Micrositio del médico y reserva del paciente

**Branch**: `003-micrositio-y-reserva-del-paciente` (sin rama dedicada; se trabaja en `main`) | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-micrositio-y-reserva-del-paciente/spec.md`

## Summary

Dar a cada médico aprobado un micrositio público (`/c/<nombre>`) y permitir que el paciente reserve, vea y cancele sus
citas sin intermediarios: entrada con «Primera cita» o «Ya soy paciente», calendario sin fechas pasadas, reserva para sí
o para sus pacientes adicionales con autorización explícita de compartir datos con el consultorio, correos de
confirmación y recordatorio con enlace, cancelación hasta el límite del consultorio, aviso al médico, y una pantalla
«Mis consultorios» para ver y revocar los vínculos.

Enfoque técnico (detalle y alternativas en [research.md](research.md)): se reutiliza todo lo de las features 1 y 2 (cuentas,
sesiones, CSRF, consentimientos, agenda, `withCalendarLock`, `listFreeSlots`, `validatePatientBookingWindow`, outbox por
cron). Lo nuevo es un módulo `src/modules/site/` (micrositio, reserva, citas del paciente, revocación), una migración
`0011_site.sql`, un tipo de actor `patient` en el contexto de médico **separado por tipos** del personal (`StaffContext`)
para que ninguna función de agenda pensada para el personal pueda recibir a un paciente, tokens de un solo uso ligados a
la cita para los enlaces de correo, el médico como `Reply-To` en los correos, y el cálculo idempotente de recordatorios
dentro de la tarea de cron que ya envía el outbox. Sin dependencias nuevas.

## Technical Context

**Language/Version**: TypeScript (modo estricto) sobre Node.js LTS (v24 en desarrollo); módulos ES.

**Primary Dependencies**: las de las features 1 y 2 (Fastify 5 y sus plugins, zod 4, mysql2, nodemailer). **Ninguna
dependencia nueva**: el logo se valida por firma de bytes (como la cédula), el mapa es un `<iframe>` del proveedor y las
fechas usan `Intl` ([research.md](research.md)).

**Storage**: MariaDB (InnoDB; pruebas en MySQL 8.0), horas en UTC. Migración `0011_site.sql`: `doctor_site`,
`data_authorization`, columnas nuevas en `doctor_patient`, `appointment`, `calendar_settings` y `one_time_token`, y
valores nuevos en los `ENUM` de rol. Logos en un directorio privado fuera de la raíz pública, servidos por una ruta.

**Testing**: vitest. Unitarias (nombre del enlace, cálculo del momento del recordatorio), de integración contra la base
de pruebas (reservas simultáneas, aislamiento, revocación, recordatorios idempotentes, tokens) y de contrato
(rutas con `fastify.inject`).

**Target Platform**: Hostinger Business Web Hosting (Node.js, MariaDB, cron por minuto); desarrollo en Windows 10.

**Project Type**: web-service con vistas HTML renderizadas en el servidor (proyecto único, igual que las features 1 y 2).

**Performance Goals**: micrositio y calendario en menos de 2 s sin mapa (SC-008); una reserva es una transacción corta
(< 300 ms sin contar el correo, que sale por cron); el mes del calendario se calcula con una sola consulta de citas y
de bloqueos.

**Constraints**: sin procesos permanentes ni colas externas (el recordatorio va en el cron del outbox); memoria
limitada; cero datos personales en logs técnicos; el mapa no puede ser punto único de fallo (cae a la dirección en
texto); correos con `Reply-To` del médico y remitente de la plataforma.

**Scale/Scope**: piloto de 3 a 5 médicos y pocos cientos de pacientes; 2 tablas nuevas, 26 rutas HTTP nuevas (7 del médico y
19 públicas y de paciente), 5 plantillas de correo nuevas y 2 modificadas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación previa | Evaluación posterior al diseño |
|-----------|-------------------|--------------------------------|
| I. Privacidad y datos de salud primero | Pasa: la spec exige casilla de autorización sin marcar, registro, aviso de privacidad en el pie y revocación. | Pasa: `data_authorization` de solo anexar (quién, consultorio, versión del aviso, cuándo); nada clínico en `appointment` ni en el micrositio; los correos no llevan datos clínicos y su asunto no lleva datos personales; revocar retira el acceso del consultorio al contacto; los registros técnicos solo llevan identificadores; el aviso al médico lleva solo el nombre. |
| II. Aislamiento por médico | Pasa: se exige que el médico salga del micrositio resuelto en el servidor. | Pasa: el médico de cada operación pública sale de `doctor_site` por el `slug` (resuelto en servidor); el contexto de paciente (`actor: patient`) se fabrica solo en el resolutor del micrositio; las funciones de agenda del personal exigen `StaffContext` (error de compilación si se les pasa un paciente); el paciente solo toca citas de las personas de su cuenta; pruebas de aislamiento y de que ninguna ruta pública expone datos de pacientes. |
| III. Integridad de la agenda | Pasa: la reserva debe usar el mismo bloqueo del médico. | Pasa: la reserva del paciente corre en `withCalendarLock` con la misma validación de solape de la feature 2 y las anticipaciones del servidor (`validatePatientBookingWindow`); la cancelación del paciente y la revocación también; los enlaces de correo muestran resumen y la cancelación ocurre con `POST`, sesión y CSRF, con token de un solo uso; pruebas de concurrencia (reserva contra reserva, contra bloqueo y contra cancelación) y de que abrir un enlace no cambia nada. |
| IV. Seguridad y validación en runtime | Pasa: zod, SQL parametrizado, límites de tasa. | Pasa: esquemas zod por ruta ([contracts/http-routes.md](contracts/http-routes.md)); límites por IP y por cuenta; logo validado por firma y tamaño; el enlace de retorno tras iniciar sesión se calcula en el servidor desde el `slug` (sin redirección abierta); CSRF en todo `POST`; CSP del mapa limitada a la ruta del micrositio. |
| V. Test-First | Pasa: se listan las pruebas obligatorias. | Pasa: [quickstart.md](quickstart.md) enumera los escenarios; concurrencia, aislamiento, caducidad y uso único de tokens, límites de cancelación y registro de autorizaciones llevan pruebas que deben fallar antes de implementar. |
| VI. Simplicidad y operación realista | Pasa con vigilancia: crece el alcance. | Pasa: sin dependencias nuevas, sin procesos nuevos (recordatorios dentro del cron del outbox), sin tablas de contadores (los límites se cuentan desde `appointment`), HTML en servidor sin JavaScript obligatorio. Riesgos abiertos: el mapa de un tercero y el límite de peticiones por IP en memoria (deuda ya anotada). |

Resultado: una desviación justificada (tipo `StaffContext`, ver Complexity Tracking); sin violaciones.

## Project Structure

### Documentation (this feature)

```text
specs/003-micrositio-y-reserva-del-paciente/
├── plan.md                          # Este archivo (/speckit-plan)
├── research.md                      # Fase 0
├── data-model.md                    # Fase 1
├── quickstart.md                    # Fase 1
├── contracts/
│   ├── http-routes.md               # Rutas HTTP, roles, esquemas y respuestas
│   └── email-notifications.md       # Correos nuevos y cambios a los de la feature 2
├── checklists/requirements.md       # Calidad de la spec (/speckit-specify)
└── tasks.md                         # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
migrations/
└── 0011_site.sql                    # doctor_site, data_authorization, columnas y ENUM nuevos
src/
├── lib/
│   ├── tenant.ts                    # + actor «patient», StaffContext, createPatientContext
│   ├── site-slug.ts                 # Validación y normalización del nombre del enlace
│   └── reminder-time.ts             # Momento del recordatorio (pura)
├── modules/
│   ├── site/
│   │   ├── site-repository.ts       # doctor_site: reservar nombre, publicar, resolver por slug
│   │   ├── site-service.ts          # Reglas de publicación del médico
│   │   ├── logo-storage.ts          # Logo: firma PNG/JPEG/WebP, 1 MB, nombre aleatorio
│   │   ├── site-resolver.ts         # slug → SiteContext / contexto de paciente (única vía)
│   │   ├── entry-service.ts         # «Ya soy paciente» / «Primera cita» (reutiliza feature 1)
│   │   ├── booking-service.ts       # Reserva del paciente (calendario, autorización, límites)
│   │   ├── availability-view.ts     # Mes y día del calendario con listFreeSlots
│   │   ├── patient-appointments.ts  # «Mis citas»: listado y cancelación del paciente
│   │   ├── appointment-links.ts     # Enlaces de correo: token, resumen, cancelar
│   │   ├── offices-service.ts       # «Mis consultorios»: listado y revocación
│   │   ├── authorization.ts         # data_authorization (solo anexar)
│   │   ├── email-templates.ts       # Plantillas nuevas
│   │   ├── doctor-routes.ts         # /medicos/micrositio…
│   │   ├── public-routes.ts         # /c/:slug… (público y entrada)
│   │   └── patient-routes.ts        # /pacientes/citas…, /pacientes/consultorios…, /citas/enlace/:token
│   ├── calendar/                    # Se amplía: cancel_hours, StaffContext, Reply-To, enlaces en correos
│   ├── patients/                    # doctor_patient con origen y revocación; filtros de activo
│   └── auth/one-time-tokens.ts      # + propósitos de cita y sujeto appointment_id
├── mail/                            # + replyTo en MailMessage y RenderedEmail
├── jobs/
│   ├── reminders-service.ts         # Recordatorios vencidos → outbox (idempotente)
│   └── outbox.ts                    # Llama primero a los recordatorios y luego procesa el outbox
├── http/views/site.ts               # Vistas del micrositio, calendario, «Mis citas» y «Mis consultorios»
├── compose.ts                       # Servicios y rutas del micrositio
tests/
├── unit/                            # site-slug, reminder-time
├── integration/                     # Concurrencia, aislamiento, revocación, recordatorios, tokens
└── contract/                        # Rutas públicas, del paciente y del médico
```

**Structure Decision**: un módulo nuevo `src/modules/site/` dentro del proyecto único, con las reglas puras (nombre del enlace, hora del
recordatorio) en `src/lib/`. La reserva del paciente **no duplica** reglas: reutiliza `resolveSlot`, los solapes y
`withCalendarLock` de la feature 2 (se factoriza lo común a una función interna compartida), y solo añade lo propio del
paciente: autorización, límites por cuenta y origen de la cita.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Un tercer tipo de actor (`patient`) en `TenantContext` y un tipo `StaffContext` que lo excluye en ~25 funciones de la feature 2 | La reserva y la cancelación del paciente deben usar la misma transacción con bloqueo y las mismas lecturas de solape; el actor queda registrado en la cita y el registro. El tipo `StaffContext` evita por compilación que una función del personal (que muestra nombres de pacientes) reciba a un paciente. | Un contexto de paciente totalmente aparte duplicaría las consultas de solape y la reserva (dos caminos que pueden divergir en la invariante central). Un solo tipo sin distinguir dejaría la defensa a una comprobación en tiempo de ejecución fácil de olvidar. |
