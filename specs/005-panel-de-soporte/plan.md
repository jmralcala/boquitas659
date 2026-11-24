# Implementation Plan: Panel de soporte

**Branch**: `005-panel-de-soporte` (sin rama dedicada; se trabaja en `main`) | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-panel-de-soporte/spec.md`

## Summary

Convertir la vista mínima de soporte (lista, detalle, aprobar, rechazar, liberar cédula) en el panel del piloto: ciclo de vida
de la cuenta del médico (**suspender, solo lectura, reactivar**), estado de micrositios con cambio de enlace, estado de la cola
de correos con reintento y cancelación, métricas agregadas del piloto, historial de acciones de solo lectura y la liberación de
cédula con vista previa de efectos. Soporte **no ve ningún dato de pacientes** (decisión FR-022) y los datos de médicos
bloqueados no se borran automáticamente (FR-023).

Enfoque técnico (detalle y alternativas en [research.md](research.md)):

- **Estado de cuenta** = columna `doctor.account_state` (`active`/`suspended`/`read_only`), independiente de `approval_status`.
  Se aplica en **tres puntos únicos** que ya existen: el resolutor de médico y las guardas (recepción y médico), y
  `isAcceptingBookings` (reservas y urgencias, dentro de la transacción). Solo lectura = el resolutor y las guardas rechazan
  toda petición que no sea `GET`/`HEAD`; suspendido = además el usuario médico queda `disabled` y sus sesiones se revocan en la
  misma transacción.
- **Historial** = tabla nueva `support_action_log` de solo anexar (disparadores como `calendar_action_log`) que recibe también las
  decisiones que hoy solo van a `doctor_review`; se migra el historial previo.
- **Métricas**: lo que ya existe se calcula al abrir el tablero (correos con `deliveryReport`, urgencias con
  `calendar_action_log`, citas por médico y médicos activos con `appointment` y el registro de acciones); lo que no existe
  (finalización y tiempo de reserva) se mide con **contadores diarios agregados** `pilot_metric_daily`, sin personas.
- **Correos**: se añade `email_outbox.last_error_code` (motivo genérico) y la vista de soporte lee solo conteos, tipo, fecha,
  intentos, motivo y destinatario **enmascarado**; nunca `payload_ref`. Los tipos con claves sensibles no se reintentan.
- **Enlaces**: el cambio de nombre pasa al panel reutilizando `changeSiteSlug` y se añade la reserva del nombre anterior
  (`site_slug_reservation`, 90 días).
- Sin dependencias nuevas ni procesos permanentes; todas las acciones son transacciones con la fila del médico bloqueada y
  validan el estado esperado (`from`), de modo que un doble envío o dos personas de soporte producen una sola transición.

## Technical Context

**Language/Version**: TypeScript (modo estricto) sobre Node.js LTS (v24 en desarrollo); módulos ES.

**Primary Dependencies**: las de las features 1 a 4 (Fastify 5, zod 4, mysql2, nodemailer). **Ninguna dependencia nueva**.

**Storage**: MariaDB (InnoDB; pruebas en MySQL 8.0), horas en UTC. Migración `0014_support_panel.sql`:
`doctor.account_state` (+ `account_state_changed_at`, `account_state_changed_by`), `support_action_log` (solo anexar) con la
migración del historial de `doctor_review`, `site_slug_reservation`, `pilot_metric_daily`, `email_outbox.last_error_code`.

**Testing**: vitest. Unitarias (transiciones de estado, enmascarado de correo, firma de la hora de apertura, cálculo de metas y periodos),
de integración contra la base de pruebas (`support-schema`, `-lifecycle`, `-readonly`, `-concurrency`, `-mail`, `-sites`,
`-metrics`, `-log`, `-release`, `-isolation`) y de contrato (`support-lifecycle`, `-ops`, `-metrics`, `-history`, con
`fastify.inject`, roles y doble factor).

**Target Platform**: Hostinger Business Web Hosting (Node.js, MariaDB, cron por minuto); desarrollo en Windows 10.

**Project Type**: web-service con vistas HTML renderizadas en el servidor (proyecto único, igual que las features 1 a 4).

**Performance Goals**: cada pantalla del panel responde en menos de 1 s con el volumen del piloto (≤ 5 médicos, decenas de
miles de correos); las acciones se aplican en una sola transacción corta.

**Constraints**: sin procesos permanentes; todo cálculo ocurre al abrir la pantalla sobre datos ya guardados; el panel nunca
ejecuta SQL sobre las tablas de pacientes ni sobre el contenido de la cola; sin impersonación.

**Scale/Scope**: 1 a 2 personas de soporte, 3 a 5 médicos; 8 pantallas y 9 acciones de cambio.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación | Estado |
|-----------|------------|--------|
| I. Privacidad y datos de salud primero | El panel no consulta datos de pacientes ni la categoría de urgencia; la cola se muestra sin `payload_ref` y con destinatario enmascarado; las métricas son conteos; el historial no guarda contenido; los textos legales de los correos de estado son provisionales hasta la revisión legal. | Cumple |
| II. Aislamiento por médico | Soporte es un rol de plataforma, no un tenant: no usa `TenantContext` y por eso **no puede** tocar datos de pacientes (el compilador y una prueba estática lo impiden). Las acciones sobre un médico reciben su id y comprueban que existe; el estado de cuenta se aplica en el resolutor de médico, así que recepción tampoco accede a una cuenta suspendida. | Cumple |
| III. Integridad de la agenda | `isAcceptingBookings` incorpora `account_state = 'active'` dentro de la transacción de reserva; suspender bloquea la fila del médico, de modo que una reserva simultánea o se completa antes o se rechaza (misma garantía que bloquear horarios). Las citas existentes se conservan y se pueden cancelar. | Cumple |
| IV. Seguridad y validación | zod en toda entrada; SQL parametrizado; CSRF y límites de tasa en rutas del panel; doble factor ya forzado por `installSupportMfa`; acciones de cambio con motivo, confirmación y estado esperado; sin `any`. | Cumple |
| V. Test-First | Pruebas obligatorias: concurrencia de acciones de soporte, aislamiento (soporte sin datos de pacientes, rol), historial de solo anexar y estado aplicado en reservas. Se escriben antes que la implementación. | Cumple |
| VI. Simplicidad y operación realista | Una columna, tres tablas pequeñas y reutilización de servicios existentes; métricas calculadas al abrir; sin cron nuevo. | Cumple |

Sin violaciones: no hay tabla de complejidad.

## Project Structure

### Documentation (this feature)

```text
specs/005-panel-de-soporte/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-routes.md
│   └── email-notifications.md
├── checklists/requirements.md
└── tasks.md              # lo crea /speckit-tasks
```

### Source Code (repository root)

```text
migrations/
└── 0014_support_panel.sql

src/
├── modules/
│   ├── support/
│   │   ├── support-service.ts        # existente: aprobar, rechazar, liberar (ahora también registra en support_action_log)
│   │   ├── account-state-service.ts  # NUEVO: suspender, solo lectura, reactivar (transacción, estado esperado, sesiones)
│   │   ├── action-log.ts             # NUEVO: anexar y listar el historial con filtros y paginación
│   │   ├── mail-queue-service.ts     # NUEVO: resumen de la cola, reintentar y cancelar (sin payload)
│   │   ├── site-admin-service.ts     # NUEVO: lista de micrositios y cambio de enlace con reserva
│   │   ├── metrics-service.ts        # NUEVO: métricas del piloto con metas y periodos
│   │   ├── email-templates.ts        # NUEVO: avisos fijos de cambio de estado
│   │   ├── support-routes.ts         # existente: se amplía (inicio, médicos, micrositios, correos, métricas, historial)
│   │   └── support-views.ts          # NUEVO: vistas HTML (se separan de las rutas)
│   ├── doctors/
│   │   ├── doctor-repository.ts      # accountState en la ficha
│   │   └── guards.ts                 # rechaza escrituras en solo lectura y cuentas suspendidas
│   ├── reception/tenant-resolver.ts  # idem para médico y recepción
│   ├── site/
│   │   ├── site-repository.ts        # isAcceptingBookings exige account_state = 'active'
│   │   ├── change-slug.ts            # reserva el nombre anterior y valida reservas
│   │   └── metrics-hooks.ts          # NUEVO: contar inicio y fin de reserva (agregado)
│   └── auth/login-service.ts         # rechazo uniforme de usuario deshabilitado (ya existe la comprobación de status)
├── mail/outbox.ts                    # guarda last_error_code al fallar
├── jobs/                             # sin cambios (no hay cron nuevo)
├── http/views/                       # vistas compartidas
└── compose.ts                        # servicios nuevos

scripts/
└── change-site-slug.ts               # se conserva y reutiliza el servicio

tests/
├── unit/                             # estado, enmascarado, metas
├── integration/                      # support-schema, -lifecycle, -readonly, -concurrency, -mail, -sites, -metrics, -log, -release, -isolation
└── contract/                         # support-lifecycle, support-ops, support-metrics, support-history
```

**Structure Decision**: proyecto único, igual que las features anteriores. Todo lo nuevo de soporte vive en `src/modules/support/`
y toca los módulos existentes solo en los tres puntos de aplicación del estado (resolutor, guardas y `isAcceptingBookings`).

## Complexity Tracking

Sin violaciones de la constitución que justificar.
