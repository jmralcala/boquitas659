# Implementation Plan: Cuentas y acceso

**Branch**: `001-cuentas-y-acceso` (sin rama dedicada; se trabaja en `main`) | **Date**: 2026-11-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-cuentas-y-acceso/spec.md`

## Summary

Construir la base de identidad de la plataforma: registro de médicos con aprobación manual de la cédula, cuentas
globales de pacientes (con menores bajo un tutor), personal de recepción por invitación, sesiones y seguridad de
cuentas (contraseñas, límite de intentos, recuperación, doble factor), consentimientos versionados y registro de
accesos al detalle de pacientes.

Enfoque técnico (detalle y alternativas en [research.md](research.md)): una sola aplicación Node.js + TypeScript con
Fastify que renderiza HTML en el servidor (sin SPA), MariaDB con SQL parametrizado, sesiones opacas guardadas en la
base de datos, tokens de un solo uso guardados como hash, correo por una tabla "outbox" procesada por cron cada
minuto, y una capa de repositorios que obliga a pasar el contexto del médico (tenant) para que una consulta sin ese
filtro no compile. Las tablas de aceptaciones y de accesos son de solo anexar, protegidas con disparadores en la base.

## Technical Context

**Language/Version**: TypeScript (modo estricto) sobre Node.js LTS; módulos ES (`"type": "module"` ya configurado).

**Primary Dependencies**: Fastify (HTTP) con `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit` y
`@fastify/multipart`; `zod` (validación en runtime); `mysql2` (MariaDB); `argon2` con respaldo `bcryptjs`
detrás de una interfaz `PasswordHasher`; `otplib` (TOTP); `nodemailer` (SMTP). Justificación de cada una en
[research.md](research.md#dependencias-nuevas). Ninguna se instala hasta `/speckit-implement`.

**Storage**: MariaDB (InnoDB), horas en UTC. Archivos de cédula en un directorio privado fuera de la raíz pública.

**Testing**: vitest. Pruebas unitarias (reglas puras), de integración contra una MariaDB real de pruebas
(aislamiento, tokens, límites, concurrencia de invitaciones) y de contrato (rutas HTTP con `fastify.inject`).

**Target Platform**: Hostinger Business Web Hosting (Node.js app, MariaDB, cron por minuto) en
`agendadental.innvend.com`; desarrollo en Windows 10.

**Project Type**: web-service con vistas HTML renderizadas en el servidor (proyecto único).

**Performance Goals**: piloto de 3 a 5 médicos y pocos cientos de pacientes; páginas de autenticación con respuesta
percibida inmediata (< 1 s p95 sin contar el hash de contraseña); hash de contraseña calibrado a ~250–500 ms.

**Constraints**: memoria limitada de hosting compartido (sin procesos permanentes adicionales, sin colas externas);
correo y tareas por cron (latencia de hasta ~1 min); cero datos personales en logs; revocación de acceso de
recepción efectiva en la siguiente petición.

**Scale/Scope**: 4 roles (paciente, médico, recepción, soporte), ~19 tablas, ~25 rutas HTTP, 13 plantillas de correo.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación previa | Evaluación posterior al diseño |
|-----------|-------------------|--------------------------------|
| I. Privacidad y datos de salud primero | Pasa: la spec exige casillas sin marcar, registro de aceptaciones, versionado y logs sin datos. | Pasa: `consent_acceptance` de solo anexar, documentos con marca `is_provisional` que bloquea en producción el alta de pacientes, el registro de médicos y las invitaciones de recepción, redacción de logs, sin historial clínico en el modelo. |
| II. Aislamiento por médico | Pasa: se exige filtro por médico en servidor. | Pasa: repositorios reciben `TenantContext` obligatorio; la recepción se revalida contra la tabla de vínculos en cada petición; prueba automática de aislamiento definida. |
| III. Integridad de la agenda | No aplica a esta feature (no hay citas). | No aplica. Se reutiliza el patrón de transacción con bloqueo de la fila del médico para el límite de 2 invitaciones. Enlaces de correo: GET nunca cambia estado, POST con CSRF. |
| IV. Seguridad y validación en runtime | Pasa: zod, SQL parametrizado, hash fuerte, cookies seguras, límites de tasa. | Pasa: cada ruta tiene esquema zod ([contracts/http-routes.md](contracts/http-routes.md)); argon2id/bcrypt; CSRF por sesión; subida de archivos validada por firma y tamaño. |
| V. Test-First | Pasa: se listan las pruebas obligatorias. | Pasa: [quickstart.md](quickstart.md) enumera los escenarios y la constitución exige pruebas antes de implementar las reglas de negocio. |
| VI. Simplicidad y operación realista | Pasa con vigilancia: se añaden dependencias. | Pasa: HTML en servidor, sin SPA ni colas externas; outbox + cron idempotente; dependencias justificadas una por una. Riesgo abierto: compilación nativa de `argon2` en el hosting (con respaldo `bcryptjs`). |

Resultado: sin violaciones; la sección Complexity Tracking queda vacía.

## Project Structure

### Documentation (this feature)

```text
specs/001-cuentas-y-acceso/
├── plan.md                          # Este archivo (/speckit-plan)
├── research.md                      # Fase 0
├── data-model.md                    # Fase 1
├── quickstart.md                    # Fase 1
├── contracts/
│   ├── http-routes.md               # Rutas HTTP, roles, esquemas y respuestas
│   └── email-notifications.md       # Correos transaccionales y sus enlaces
├── checklists/requirements.md       # Calidad de la spec (/speckit-specify)
└── tasks.md                         # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
migrations/                          # SQL numerado (0001_*.sql ...) + disparadores de solo anexar
src/
├── index.ts                         # Arranque del servidor
├── config/                          # Lectura y validación (zod) de variables de entorno
├── db/                              # Pool mysql2, ejecutor de migraciones, transacciones
├── http/                            # Fastify: plugins (sesión, CSRF, límites, cabeceras), vistas HTML
│   └── views/                       # Plantillas como funciones TS con escape obligatorio
├── lib/                             # Utilidades puras: tokens, normalización de correo/teléfono/cédula, fechas
├── modules/
│   ├── auth/                        # Contraseñas, sesiones, login, recuperación, TOTP, dispositivos
│   ├── doctors/                     # Registro, estado de aprobación, cédula (archivo)
│   ├── patients/                    # Cuenta de paciente, pacientes adicionales, relación médico-paciente
│   ├── reception/                   # Invitaciones, vínculos con médicos, permisos
│   ├── legal/                       # Documentos legales, versiones, aceptaciones
│   ├── audit/                       # Registro de accesos al detalle de pacientes y acciones de recepción
│   └── support/                     # Vista mínima: revisar, aprobar, rechazar, liberar cédula
├── mail/                            # Plantillas, outbox y transporte SMTP
└── jobs/                            # Tareas de cron idempotentes (envío de outbox, limpieza de tokens vencidos)
scripts/
└── create-support-user.ts           # Alta de soporte fuera del flujo público (pide la contraseña por entrada estándar)
tests/
├── unit/
├── integration/                     # Requieren TEST_DATABASE_URL
└── contract/
```

**Structure Decision**: proyecto único Node/TypeScript con módulos por dominio dentro de `src/modules/`. Se descarta
separar frontend y backend porque el HTML se genera en el servidor, lo que reduce superficie de ataque, memoria y
piezas por desplegar en hosting compartido. El código existente (`src/index.ts`, `src/index.test.ts`) se conserva y
se amplía.

## Complexity Tracking

Sin violaciones de la constitución; no se requiere justificación.
