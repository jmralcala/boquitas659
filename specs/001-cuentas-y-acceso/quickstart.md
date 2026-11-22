# Quickstart: validar Cuentas y acceso

Guía para comprobar de punta a punta que la feature funciona. No contiene código de implementación; los detalles están
en [data-model.md](data-model.md) y [contracts/](contracts/).

## Prerrequisitos

- Node.js LTS y las dependencias de [research.md](research.md#dependencias-nuevas) instaladas.
- MariaDB local con dos bases vacías: una de desarrollo y una de pruebas.
- Variables de entorno (a partir de `.env.example`, sin commitear valores): conexión a la base, `TEST_DATABASE_URL`,
  `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, configuración SMTP (o un transporte de prueba que escriba en memoria),
  `APP_ENV` (`development` | `production`), directorio privado de archivos.

## Preparación

1. `npm run migrate` aplica las migraciones y crea los disparadores de solo anexar.
2. `npm run support:create` crea la cuenta de soporte (contraseña por entrada estándar).
3. `npm run dev` levanta la aplicación; en otra terminal `npm run jobs:outbox` (o su equivalente de pruebas) procesa los
   correos.

## Verificación automática

`npm run lint && npm run typecheck && npm run test && npm run build` deben pasar. Las pruebas de integración usan
`TEST_DATABASE_URL`. Escenarios que deben tener prueba (principio V):

| # | Escenario | Historia / FR |
|---|-----------|---------------|
| 1 | Registro de médico sin casillas marcadas se bloquea | US1 · FR-002, FR-019 |
| 2 | Médico pendiente o rechazado no accede a funciones | US1 · FR-005, SC-004 |
| 3 | Aprobar inicia la prueba de 5 días en ese instante y avisa | US1 · FR-008 |
| 4 | Cédula o móvil duplicados se rechazan; liberar permite reutilizar | US1 · FR-003, FR-004, FR-007 |
| 5 | Alta de paciente registra aceptación (quién, documento, versión, cuándo) | US2 · FR-017, FR-020 |
| 6 | Paciente adicional queda bajo el tutor con su propia aceptación | US2 · FR-014, FR-017 |
| 7 | **Aislamiento**: el médico B no ve ni obtiene al paciente del médico A (404) | US2 · FR-013, FR-040, SC-005 |
| 8 | Contraseña corta, común o filtrada se rechaza; larga sin símbolos se acepta | US3 · FR-031 |
| 9 | Fallos repetidos aumentan la espera; mismo mensaje con correo inexistente | US3 · FR-033 |
| 10 | Sesión caduca por inactividad y por tope absoluto | US3 · FR-035 |
| 11 | Recuperación: respuesta uniforme; enlace usado o vencido no funciona; abrirlo no lo consume | US3 · FR-034, SC-008 |
| 12 | Dos POST simultáneos con el mismo token: solo uno lo consume | US3 · FR-026, FR-034 |
| 13 | Aviso por correo en cambio de contraseña y en dispositivo nuevo | US3 · FR-037 |
| 14 | Cambios sensibles piden contraseña actual | US3 · FR-038 |
| 15 | Invitaciones simultáneas no superan 2 (pendientes cuentan) | US4 · FR-025 |
| 16 | Invitación caducada o ya usada se rechaza; abrirla no la consume | US4 · FR-026 |
| 17 | Recepción no puede cambiar configuración, pagos, móvil, cédula ni invitar (403) | US4 · FR-027 |
| 18 | Retirar a recepción corta la sesión en la siguiente petición | US4 · FR-028, SC-009 |
| 19 | Recepción en dos médicos no mezcla datos entre ellos | US4 · FR-029 |
| 20 | Acciones de recepción registran quién las hizo | US4 · FR-030 |
| 21 | Nueva versión de un documento obliga a aceptarla; registro es de solo anexar | US5 · FR-020, FR-021 |
| 22 | En producción, documento provisional bloquea el alta de pacientes | US5 · FR-023 |
| 23 | Aviso de privacidad accesible sin sesión | US5 · FR-022 |
| 24 | Soporte sin TOTP queda obligado a configurarlo; médico con TOTP lo usa | US6 · FR-036 |
| 25 | Abrir detalle de paciente (permitido y denegado) escribe `patient_access_log` sin contenido | US6 · FR-041, SC-007 |
| 26 | Los registros técnicos no contienen contraseñas, tokens ni datos personales | FR-042 |
| 27 | `consent_acceptance` y `patient_access_log` rechazan UPDATE y DELETE | FR-020, FR-041 |

## Recorrido manual (humo)

1. Entrar a `/medicos/registro`, completar con una cédula de prueba y verificar que el correo a soporte llega sin adjuntos.
2. Iniciar sesión como soporte (con TOTP), abrir la solicitud, ver la cédula y aprobarla; comprobar el correo al médico.
3. Entrar como médico, invitar a una persona de recepción y aceptar la invitación desde el enlace del correo.
4. Crear un paciente en `/pacientes/registro`, añadir un menor, y (con un vínculo de prueba) abrir su detalle como médico;
   comprobar la fila en `patient_access_log`.
5. Pedir recuperación de contraseña, abrir el enlace y confirmar que se puede usar una sola vez.

## Humo de despliegue en Hostinger (antes del piloto)

- Probar que `argon2` carga en el hosting; si no, activar `bcryptjs`.
- Probar el cron de un minuto con `jobs:outbox` y medir la latencia real de los correos.
- Revisar SPF, DKIM y DMARC con un correo de prueba y los límites de envío del SMTP.
- Confirmar que el directorio de cédulas no está en la raíz pública.
