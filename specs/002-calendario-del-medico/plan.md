# Implementation Plan: Calendario del médico (agenda)

**Branch**: `002-calendario-del-medico` (sin rama dedicada; se trabaja en `main`) | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-calendario-del-medico/spec.md`

## Summary

Dar a cada médico aprobado un calendario configurable (duración, intervalo, zona horaria, horario semanal,
anticipaciones) y una agenda por día y semana donde él y su recepción crean y cancelan citas para pacientes con
cuenta y bloquean o desbloquean horarios sin cita. La invariante central es que el calendario nunca queda
inconsistente: nada de doble reserva, nada de bloqueos sobre citas, aun con peticiones simultáneas.

Enfoque técnico (detalle y alternativas en [research.md](research.md)): los espacios **no se guardan**, se calculan
al leer a partir de la configuración (modelo A: el intervalo es una pausa, los espacios empiezan cada
duración + intervalo). Se guardan solo las citas (con inicio y fin en UTC) y los bloqueos (rangos UTC). Toda
mutación (crear cita, cancelar, bloquear, desbloquear, cambiar configuración) corre en una transacción que primero
bloquea la fila del médico, revisa solapes con consultas de rango y escribe; un índice único sobre el inicio de la
cita vigente actúa de respaldo. Sin dependencias nuevas: la conversión de zona horaria usa `Intl` de Node. Los avisos
por correo reutilizan el outbox de la feature 1. Las acciones quedan en una tabla de solo anexar.

## Technical Context

**Language/Version**: TypeScript (modo estricto) sobre Node.js LTS (v24 en desarrollo); módulos ES.

**Primary Dependencies**: las de la feature 1 (Fastify 5 y sus plugins, zod 4, mysql2, nodemailer). **Ninguna
dependencia nueva**: la zona horaria se resuelve con `Intl.DateTimeFormat` ([research.md](research.md#2-zonas-horarias-sin-dependencias)).

**Storage**: MariaDB (InnoDB; pruebas en MySQL 8.0), horas en UTC (`DATETIME(3)`). Migración `0009_calendar.sql`:
`calendar_settings`, `calendar_hours`, `appointment`, `calendar_block`, `calendar_action_log`.

**Testing**: vitest. Unitarias (generación de espacios, conversión de zona y cambios de hora, validación de
configuración), de integración contra la base de pruebas (aislamiento entre médicos, concurrencia de reservas,
bloqueos y cancelaciones, cambios de configuración con citas existentes) y de contrato (rutas con `fastify.inject`).

**Target Platform**: Hostinger Business Web Hosting (Node.js, MariaDB, cron por minuto); desarrollo en Windows 10.

**Project Type**: web-service con vistas HTML renderizadas en el servidor (proyecto único, igual que la feature 1).

**Performance Goals**: vista semanal en menos de 2 s con hasta 300 citas (SC-008); crear o cancelar una cita, una
transacción corta (< 200 ms sin contar el correo, que sale por cron).

**Constraints**: sin procesos permanentes ni colas externas; transacciones cortas porque el bloqueo de la fila del
médico serializa sus mutaciones; cero datos personales en logs técnicos; MariaDB y MySQL 8 con el mismo SQL.

**Scale/Scope**: piloto de 3 a 5 médicos, decenas de citas al día por médico; 5 tablas nuevas, 14 rutas HTTP, 2
plantillas de correo.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación previa | Evaluación posterior al diseño |
|-----------|-------------------|--------------------------------|
| I. Privacidad y datos de salud primero | Pasa: la agenda no guarda contenido clínico; solo tipo de cita (convencional). | Pasa: `appointment` no tiene campos clínicos ni de triaje; la agenda muestra solo el nombre del paciente (detalle por la ruta auditada de la feature 1); los correos no llevan datos clínicos y su asunto no lleva datos personales; los registros técnicos solo llevan identificadores; la búsqueda de cuenta por correo exacto queda limitada y registrada. |
| II. Aislamiento por médico | Pasa: se exige `TenantContext` en toda consulta. | Pasa: todas las funciones de repositorio de agenda reciben `TenantContext` como primer parámetro y filtran por `doctor_id`; un identificador ajeno responde 404; la recepción se revalida en cada petición con el `TenantResolver` existente; pruebas de aislamiento para cada ruta. Una cita solo puede referirse a un paciente vinculado al mismo médico (el vínculo se crea en la misma transacción, solo desde un paciente ya vinculado o hallado con un boleto firmado). |
| III. Integridad de la agenda | Pasa: la spec fija la invariante y la regla de bloqueo. | Pasa: toda mutación bloquea la fila del médico (`SELECT … FOR UPDATE`), revisa solapes de rango e inserta; índice único `(doctor_id, active_start_utc)` como respaldo; bloquear y reservar comparten transacción y bloqueo; horas en UTC, mostradas en la zona del consultorio; pruebas de concurrencia para reservas, bloqueo contra reserva y cancelación contra reserva. Las anticipaciones por médico se guardan aquí y las comprueba el servidor en cada reserva de paciente (feature 3; esta feature expone la función de validación). |
| IV. Seguridad y validación en runtime | Pasa: zod en cada ruta, SQL parametrizado, CSRF. | Pasa: esquemas zod por ruta ([contracts/http-routes.md](contracts/http-routes.md)); `POST` con CSRF; ningún enlace de correo cambia estado (los correos de esta feature no llevan enlaces de acción); sin `any`. |
| V. Test-First | Pasa: se listan las pruebas obligatorias. | Pasa: [quickstart.md](quickstart.md) enumera los escenarios; concurrencia, aislamiento y registro de acciones llevan pruebas que deben fallar antes de implementar. |
| VI. Simplicidad y operación realista | Pasa con vigilancia: riesgo de complejidad en zona horaria. | Pasa: sin dependencias nuevas, sin espacios materializados, sin tareas programadas nuevas (los correos reutilizan el outbox). Riesgos abiertos: columna generada e índice único en MariaDB, y disparadores de solo anexar en Hostinger (plan B ya documentado en feature 1). |

Resultado: sin violaciones; la sección Complexity Tracking queda vacía.

## Project Structure

### Documentation (this feature)

```text
specs/002-calendario-del-medico/
├── plan.md                          # Este archivo (/speckit-plan)
├── research.md                      # Fase 0
├── data-model.md                    # Fase 1
├── quickstart.md                    # Fase 1
├── contracts/
│   ├── http-routes.md               # Rutas HTTP, roles, esquemas y respuestas
│   └── email-notifications.md       # Correos de cita agendada y cancelada
├── checklists/requirements.md       # Calidad de la spec (/speckit-specify)
└── tasks.md                         # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
migrations/
└── 0009_calendar.sql                # Tablas nuevas, índice único de cita vigente, disparadores de solo anexar
src/
├── lib/
│   ├── zoned-time.ts                # Local ↔ UTC con Intl, huecos y repeticiones de cambio de hora
│   └── calendar-slots.ts            # Generación pura de espacios de un día y estado (libre/ocupado/bloqueado)
├── modules/
│   └── calendar/
│       ├── settings.ts              # Esquemas zod y reglas de la configuración; valores por defecto
│       ├── settings-repository.ts   # Lectura/escritura de configuración y franjas (reemplazo completo en transacción)
│       ├── calendar-lock.ts         # Transacción con bloqueo de la fila del médico (única vía de mutar la agenda)
│       ├── appointment-repository.ts# Citas: insertar, cancelar, solapes, listados por rango (siempre con ctx)
│       ├── appointment-service.ts   # Crear/cancelar cita: reglas, vínculo médico-paciente, encolado de correo
│       ├── block-repository.ts      # Bloqueos: insertar, borrar, solapes, listados
│       ├── block-service.ts         # Bloquear/desbloquear con rechazo si hay citas
│       ├── agenda-service.ts        # Vista de día y semana: espacios + citas + bloqueos
│       ├── availability.ts          # Reglas de anticipación mínima/máxima para la reserva del paciente (feature 3)
│       ├── patient-picker.ts        # Pacientes vinculados, búsqueda por correo exacto con límite y boleto firmado
│       ├── action-log.ts            # Registro de acciones (solo anexar) y conteo para el límite de búsquedas
│       ├── email-templates.ts       # appointment_created, appointment_cancelled
│       └── routes.ts                # Rutas HTTP de agenda, citas, bloqueos y configuración
├── http/views/                      # Vistas de agenda (día, semana, configuración, nueva cita, bloqueos)
├── compose.ts                       # Registrar servicios y rutas del calendario
└── mail/templates.ts                # Añadir las plantillas del calendario al registro
tests/
├── unit/                            # zoned-time, calendar-slots, settings
├── integration/                     # Aislamiento, concurrencia, bloqueo con conflictos, cambios de configuración
└── contract/                        # Rutas HTTP de la agenda
```

**Structure Decision**: un módulo nuevo `src/modules/calendar/` dentro del proyecto único, con las reglas puras
(zona horaria y generación de espacios) en `src/lib/` para probarlas sin base de datos. Toda mutación pasa por
`calendar-lock.ts`, de modo que no exista un camino que escriba citas o bloqueos sin tomar el bloqueo del médico. No
se separa un servicio de disponibilidad: la feature 3 importará `availability.ts` y `calendar-slots.ts`.

## Complexity Tracking

Sin violaciones de la constitución; no se requiere justificación.
