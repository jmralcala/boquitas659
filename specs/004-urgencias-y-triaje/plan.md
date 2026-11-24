# Implementation Plan: Urgencias y triaje

**Branch**: `004-urgencias-y-triaje` (sin rama dedicada; se trabaja en `main`) | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-urgencias-y-triaje/spec.md`

## Summary

Permitir que un paciente con sesión pida desde el micrositio una cita de urgencia: contesta una pregunta de señales de alarma
(que bloquea y dirige a emergencias), elige una de cinco categorías con semáforo, resuelve un CAPTCHA y el servidor le asigna
el espacio libre más próximo dentro de la ventana de su nivel, sin que vea calendario. Si no hay espacio, ve el móvil de
emergencias del médico y el aviso de hospital. El médico recibe un aviso con la categoría que **solo vive en la cola de envío**.

Enfoque técnico (detalle y alternativas en [research.md](research.md)): la urgencia es una cita de la feature 2 con
`kind = 'urgent'`, así que **hereda la misma transacción con bloqueo (`withCalendarLock`), el mismo índice único y las mismas
lecturas de solape**. Las franjas de urgencia son filas de `calendar_hours` con un `kind` nuevo (no una tabla aparte) y la
búsqueda del espacio es una función pura sobre una sola lectura de citas y bloqueos. La categoría viaja en el `payload` del
outbox y se borra al entregarse, al cancelarse o fallar (con aviso genérico) o a las 24 h. Los contadores (3 solicitudes por
24 h) salen de `calendar_action_log` (acción nueva `urgent_requested`, sin categoría), y el contenido del triaje es un módulo
versionado con bandera de «revisado por un dentista» que bloquea el flujo en producción mientras sea provisional. El CAPTCHA es
Cloudflare Turnstile verificado con `fetch` (sin dependencias nuevas) detrás de una interfaz que las pruebas sustituyen.

## Technical Context

**Language/Version**: TypeScript (modo estricto) sobre Node.js LTS (v24 en desarrollo); módulos ES.

**Primary Dependencies**: las de las features 1 a 3 (Fastify 5, zod 4, mysql2, nodemailer). **Ninguna dependencia nueva**: la
verificación del CAPTCHA usa el `fetch` de Node y el widget es un `<script>` del proveedor ([research.md](research.md)).

**Storage**: MariaDB (InnoDB; pruebas en MySQL 8.0), horas en UTC. Migración `0013_urgent.sql`: columna `kind` en
`calendar_hours`, `urgent_min_notice_minutes` en `calendar_settings`, valor `'urgent'` en `appointment.kind` y acción
`urgent_requested` en `calendar_action_log`. Sin tablas nuevas.

**Testing**: vitest. Unitarias (búsqueda del espacio más próximo, contenido del triaje, verificación del CAPTCHA), de
integración contra la base de pruebas (solicitudes simultáneas, aislamiento, límites, categoría que nunca se guarda,
borrado a las 24 h) y de contrato (rutas con `fastify.inject`).

**Target Platform**: Hostinger Business Web Hosting (Node.js, MariaDB, cron por minuto); desarrollo en Windows 10.

**Project Type**: web-service con vistas HTML renderizadas en el servidor (proyecto único, igual que las features 1 a 3).

**Performance Goals**: la solicitud (verificar CAPTCHA, buscar y agendar) en menos de 5 s con el proveedor del CAPTCHA
respondiendo y menos de 300 ms dentro de la transacción; el aviso al médico sale en el siguiente minuto de cron (SC-003: menos
de 3 minutos en el 98 %).

**Constraints**: sin procesos permanentes (el aviso y el borrado de la categoría van en el cron de `jobs:outbox`); la
categoría nunca en tablas, logs ni métricas fuera de la cola de envío; el CAPTCHA falla **cerrado** (si no hay verificación se
muestra el móvil de emergencias); sin dependencias nuevas; el proveedor del CAPTCHA no recibe la categoría ni datos del paciente.

**Scale/Scope**: piloto de 3 a 5 médicos; 0 tablas nuevas, 2 rutas HTTP nuevas (`GET`/`POST /c/:slug/urgencia`) y cambios a
3 rutas de la feature 2 (configuración, detalle de cita y agenda); 2 plantillas de correo nuevas (`doctor_urgent_notice` y
`doctor_urgent_generic`), 1 modificada (`appointment_created`) y 2 reutilizadas sin cambios (cancelaciones de la feature 3).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación previa | Evaluación posterior al diseño |
|-----------|-------------------|--------------------------------|
| I. Privacidad y datos de salud primero | Pasa con vigilancia: es la feature más cercana a datos de salud (la categoría). | Pasa: la categoría vive solo en `email_outbox.payload_ref` y se elimina al entregarse, cancelarse, abandonarse (con aviso genérico) o a las 24 h (prueba que recorre todas las tablas); la señal de alarma no se guarda ni se registra; `appointment` guarda solo `kind`; el registro de acciones no lleva categoría; el aviso al médico no lleva nombre; el CAPTCHA no recibe datos de salud; el contenido médico es provisional y bloquea el flujo en producción hasta que un dentista lo valide. |
| II. Aislamiento por médico | Pasa: se reutiliza el contexto de paciente de la feature 3. | Pasa: el médico sale del `slug` resuelto en el servidor; la urgencia usa `TenantContext` de paciente (`resolvePatientSite`) y las mismas consultas filtradas por `ctx.doctorId`; el personal no puede pedir urgencias por este flujo (403); pruebas de que un paciente no alcanza urgencias de otra cuenta. |
| III. Integridad de la agenda | Pasa: la asignación debe ser atómica. | Pasa: buscar el espacio, comprobar solape con citas y bloqueos, insertar y registrar ocurre dentro de `withCalendarLock` con `assertSlotBookable`/índice único como respaldo; prueba de concurrencia obligatoria (solicitudes simultáneas contra un solo espacio, contra bloqueo, contra una reserva convencional y contra una cancelación); un bloqueo siempre manda sobre una urgencia; la urgencia nunca desplaza citas. |
| IV. Seguridad y validación en runtime | Pasa: zod, límites de tasa y CAPTCHA. | Pasa: categoría y señales validadas con zod contra la lista fija; CAPTCHA verificado en el servidor **antes** de buscar espacio (falla cerrado); límite por IP, por cuenta (3 cada 24 h) y una urgencia activa por paciente; CSRF en el `POST`; CSP ampliada solo en la ruta de urgencia para el widget; la IP del visitante es lo único que se manda al proveedor; el secreto del CAPTCHA solo en variables de entorno. |
| V. Test-First | Pasa: se listan las pruebas obligatorias. | Pasa: [quickstart.md](quickstart.md) enumera los escenarios; concurrencia, aislamiento, límites de urgencia y la prueba de «categoría nunca persistida» se escriben antes de implementar. |
| VI. Simplicidad y operación realista | Pasa con vigilancia: toca el outbox compartido. | Pasa: sin dependencias, sin tablas nuevas, sin procesos nuevos (cron del outbox), horarios de urgencia reutilizando `calendar_hours`, contadores desde el registro de acciones y contenido del triaje como módulo versionado. Los avisos de urgencia no se bloquean por cuota y su entrega a tiempo tiene prueba y paso de humo antes del piloto. Riesgo abierto: dependencia de un tercero (Turnstile) en el paso de urgencia, mitigada con el respaldo «llama al médico». |

Resultado: sin violaciones. Se anotan dos desviaciones menores justificadas en Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/004-urgencias-y-triaje/
├── plan.md                          # Este archivo (/speckit-plan)
├── research.md                      # Fase 0
├── data-model.md                    # Fase 1
├── quickstart.md                    # Fase 1
├── contracts/
│   ├── http-routes.md               # Rutas nuevas y cambios a las de la feature 2
│   └── email-notifications.md       # Correos nuevos y cambios; ciclo de vida de la categoría
├── checklists/requirements.md       # Calidad de la spec (/speckit-specify)
└── tasks.md                         # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
migrations/
└── 0013_urgent.sql                  # calendar_hours.kind, urgent_min_notice_minutes, appointment.kind, acción urgent_requested
src/
├── lib/
│   ├── calendar-slots.ts            # + HoursRange.kind y SlotTime.kind; generateSlotsForDay conserva el tipo
│   └── urgent-slot.ts               # findNearestUrgentSlot (pura): ventana, anticipación, desempate
├── modules/
│   ├── urgent/
│   │   ├── triage-content.ts        # 5 categorías, ventanas, textos y bandera de revisión (versionado)
│   │   ├── captcha.ts               # CaptchaVerifier + Turnstile (fetch) + modo desarrollo
│   │   ├── urgent-service.ts        # requestUrgent: orden de comprobaciones bajo withCalendarLock
│   │   ├── urgent-limits.ts         # una activa por paciente, 3 por 24 h por cuenta (desde calendar_action_log)
│   │   ├── email-templates.ts       # doctor_urgent_notice, doctor_urgent_generic
│   │   └── routes.ts                # GET/POST /c/:slug/urgencia (registrado desde compose)
│   ├── calendar/                    # Se amplía: horas por kind, assertSlotBookable por tipo, agenda y detalle con etiqueta
│   ├── site/                        # Se amplía: cancelAsPatient sin plazo para urgencias; límites de reserva sin urgencias
│   └── doctors/                     # (sin cambios; el móvil de emergencias ya existe)
├── mail/
│   └── outbox.ts                    # + sensitiveKeys: se borran al enviar, cancelar o abandonar; aviso genérico
├── jobs/
│   ├── urgent-notices.ts            # expira categorías a las 24 h y encola el aviso genérico (idempotente)
│   ├── reminders-service.ts         # + solo citas convencionales
│   └── outbox.ts                    # Llama a urgent-notices antes de procesar
├── config/env.ts                    # + TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY (opcionales fuera de producción)
├── http/views/urgent.ts             # Formulario, resultado, sin espacio, alarma y bloqueado
└── compose.ts                       # Servicio, verificador de CAPTCHA inyectable y rutas
tests/
├── unit/                            # urgent-slot, triage-content, captcha
├── integration/                     # Concurrencia, límites, aislamiento, categoría no persistida, expiración
└── contract/                        # Rutas de urgencia y cambios a la configuración y la agenda
```

**Structure Decision**: un módulo nuevo `src/modules/urgent/` dentro del proyecto único, con la búsqueda del espacio como
función pura en `src/lib/`. La urgencia **no duplica** la reserva: reutiliza `withCalendarLock`, `assertSlotBookable`,
`insertAppointment` y la autorización de datos de la feature 3, y solo añade lo propio: triaje, ventana por nivel, límites de
urgencia y el aviso con categoría efímera.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| El outbox compartido gana un mecanismo de «claves sensibles» que se borran al llegar a un estado final (enviado, cancelado, abandonado) y un paso de expiración a las 24 h | La constitución exige que la categoría viva solo en la cola de envío y se borre al entregarse o a las 24 h como máximo; el outbox hoy conserva el `payload` de las filas enviadas hasta 30 días | Guardar la categoría en otra tabla o no enviarla obligaría a otra estructura con su propia retención; no mandar la categoría contradice la decisión de producto (el aviso al médico la lleva) |
| Dependencia de un servicio externo (Turnstile) en una ruta crítica | La constitución IV exige CAPTCHA en el paso de urgencia | Un reto propio (cuenta aritmética) es fácil de automatizar y no frena el abuso; si el proveedor falla se **cierra** el flujo y se muestra el móvil de emergencias, así no es punto único de fallo para la atención |
