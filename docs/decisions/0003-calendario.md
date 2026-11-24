# 0003 · Calendario del médico (agenda)

Estado: implementado (feature 002). Fecha: 2026-11-22.
Origen: `specs/002-calendario-del-medico/` (spec, plan, research, data-model, contratos, quickstart) y constitución v1.1.0 (principios II y III).

## Decisiones técnicas

- **Espacios derivados, no guardados.** Se calculan al leer desde la configuración vigente: dentro de cada franja, los inicios son `inicio + k × (duración + intervalo)` mientras el espacio quepa. El intervalo es una **pausa** entre citas (modelo A). Cambiar la configuración nunca toca citas ni bloqueos.
- **Integridad de la agenda.** Toda mutación (crear o cancelar cita, bloquear, desbloquear, cambiar la configuración) pasa por `withCalendarLock`: una transacción que bloquea la fila del médico (`SELECT … FOR UPDATE` sobre una fila que siempre existe), revisa solapes por rango y escribe. Respaldo: índice único `(doctor_id, active_start_utc)` sobre una columna generada que solo tiene valor mientras la cita está vigente. Dentro del bloqueo solo se usa la conexión de la transacción (nunca otra del pool: se agotaría con carga).
- **Bloqueos.** Rango semiabierto `[inicio, fin)`; se rechaza por completo si incluye citas vigentes cuyo fin aún no llega (una cita pasada no cuenta). El rechazo registra `block_rejected` y la excepción con la lista se lanza después de confirmar la transacción. Máximo 366 días, motivo de hasta 200 caracteres; desbloquear borra el bloqueo (la constancia queda en el registro de acciones).
- **Zonas horarias sin dependencias.** `src/lib/zoned-time.ts` usa `Intl`; lista cerrada de zonas de México; una hora que no existe (salto de verano) no genera espacio y una repetida toma la primera ocurrencia sin duplicados.
- **Aislamiento.** Toda función de agenda recibe `TenantContext` primero; las lecturas de la tabla `patient` siguen viviendo solo en `patient-repository.ts` (nombres por `listPatientNamesForDoctor`, correo de aviso por `findNotificationEmailForDoctor`). La auditoría de rutas (`tests/integration/route-audit.test.ts`) comprueba ambas reglas y los contratos de las dos features.
- **Cita para un paciente vinculado o hallado por correo exacto.** La búsqueda devuelve nombres y un **boleto firmado** (HMAC-SHA256 con `SESSION_SECRET`, prefijo `calendar-patient:`, ligado a médico, actor y paciente, 15 minutos). Sin boleto, un `patientId` no vinculado es inalcanzable (404); así no se pueden vincular pacientes recorriendo identificadores consecutivos. Límite de 30 búsquedas por hora por persona y 60 por médico, contadas desde `calendar_action_log`.
- **Correos.** `appointment_created` y `appointment_cancelled` por el outbox de la feature 1, encolados en la misma transacción de la mutación. El de «agendada» se cancela si la cita ya no está vigente al enviarse. Sin enlaces de acción ni datos clínicos; asunto sin datos personales.
- **Registro de acciones de solo anexar** (`calendar_action_log`, disparadores como `patient_access_log`): quién, rol, médico, acción, ids y resultado; sin nombres, correos ni teléfonos.
- **Disponibilidad para la feature 3.** `src/modules/calendar/availability.ts` expone `validatePatientBookingWindow` (anticipación mínima y máxima del médico, bordes inclusivos) y `listFreeSlots`. **La ruta de reserva del paciente (feature 3) debe llamar a `validatePatientBookingWindow` y llevar su prueba de integración**: esta feature solo prueba la regla de forma unitaria porque no tiene reservas de pacientes.

## Valores por defecto y topes

| Valor | Defecto | Límites |
|-------|---------|---------|
| Duración de la cita | 45 min | 15–180, en pasos de 5 |
| Pausa entre citas | 15 min | 0–60, en pasos de 5 |
| Zona horaria | Ciudad de México | lista cerrada de zonas de México |
| Anticipación mínima | 2 horas | 0 h a 7 días (horas enteras); siempre menor que la máxima |
| Anticipación máxima | 60 días | 1–365 días |
| Franjas por día | — | hasta 4, sin solaparse, sin cruzar la medianoche |
| Consulta y agenda del personal | — | hasta 730 días adelante y 365 atrás |
| Duración de un bloqueo | — | hasta 366 días |
| Búsquedas por correo | — | 30 por hora por persona (con todos sus médicos) y 60 por médico |
| Crear o cancelar citas | — | 60 por hora por persona (con todos sus médicos) y 5 citas creadas por hora por persona para un mismo paciente |
| Retención del registro de acciones | — | 90 días |

## Riesgos abiertos

- **Columna generada indexada y disparadores en MariaDB/Hostinger.** Probado en MySQL 8.0; falta repetir los escenarios de concurrencia (17, 21 y 25 de `quickstart.md`) contra MariaDB y comprobar que acepta la columna generada indexada de `appointment` y los disparadores de `calendar_action_log`. Plan B de la columna: una columna normal `active_start_utc` mantenida por el servicio (la prueba de concurrencia sigue valiendo). Plan B de los disparadores: el de la feature 1.
- **Retención y borrado de citas.** Las citas canceladas se conservan; el borrado por derechos del titular sigue sin definir (supuesto 2 de 0001).
- **Listado de pacientes visible para el médico.** El selector muestra los nombres de los pacientes vinculados (el mismo alcance que ya tiene el médico en la feature 1).
- **Búsqueda por correo exacto: oráculo aceptado.** Muestra los nombres de los pacientes de esa cuenta (menores incluidos) y confirma que la cuenta existe, a personal sin relación previa. Se acepta igual que el oráculo del alta de paciente de la feature 1; lo mitigan el correo exacto, el límite y el registro (`patient_lookup`).
- **Límite de búsquedas suave.** Dos búsquedas simultáneas pueden pasar el límite por una: es un freno contra la enumeración, no una garantía exacta.
- **Anticipación mínima en horas enteras.** El formulario no permite, por ejemplo, 30 minutos; si hace falta, se cambia a minutos sin tocar la base (ya se guarda en minutos).

## Revisión independiente (T061, 2026-11-22)

Dos revisiones de solo lectura (código y seguridad) sobre el diff de la feature; cada hallazgo se verificó contra el código antes de actuar.

**Corregido**
- **Límite de búsquedas por correo eludible con ráfagas** (media). Contar, buscar y registrar ocurría sin bloqueo: N peticiones simultáneas pasaban el conteo a la vez. Ahora todo ocurre bajo el bloqueo del médico (`withCalendarLock`); prueba nueva: 45 búsquedas simultáneas dejan pasar exactamente 30.
- **Bloqueos sin tope de lejanía** (baja). `createBlock` no aplicaba los 730 días de adelanto (un año como 9999 acababa en error de base de datos); ahora el inicio y el fin se validan (hasta 730 días adelante; el inicio, hasta 365 atrás) y devuelven 400. `GET /agenda/bloqueos` lista como máximo 200.
- **Números del formulario permisivos** (baja). `z.coerce.number` aceptaba «1e1» o «0x10»; ahora solo dígitos.

**Aceptado o pendiente (anotado, sin cambio de código)**
- **Recepción puede vincular pacientes con un boleto** (diseño; **decisión confirmada por el usuario el 2026-11-23: la recepción puede vincular igual que el médico**): con el correo exacto de una cuenta, el médico o su recepción pueden vincular al titular o a un menor con el consultorio, sin consentimiento adicional del paciente; después ven su contacto por la ruta auditada. Alternativas: que solo el médico use boletos, o que recepción solo agende a pacientes ya vinculados.
- ~~Correo como canal de contenido libre~~ — **mitigado el 2026-11-23**: el teléfono del consultorio ya se valida al registrarse (10 dígitos) y la plantilla vuelve a exigirlo antes de imprimirlo; crear y cancelar citas tiene límite (60 por hora por persona y 5 creaciones por hora por persona y paciente, bajo el bloqueo del médico, con 429 y espera calculada). El nombre del médico sigue yendo en el correo (es el remitente lógico del aviso).
- ~~`calendar_action_log` crece sin límite~~ — **resuelto el 2026-11-23: se conserva 90 días.** La migración `0010_calendar_log_retention.sql` cambia el disparador de borrado para que solo permita borrar filas de más de 90 días (UPDATE se rechaza siempre y lo reciente nunca se borra); la tarea `jobs:cleanup` (cron) borra hasta 10 000 filas antiguas por corrida. El disparador usa una sola sentencia `IF … END IF` (sin BEGIN/END); **hay que comprobarlo en MariaDB/Hostinger** junto con los demás disparadores.
- ~~Contador de búsquedas por médico, no por persona~~ — **corregido el 2026-11-23**: el límite por persona cuenta sus búsquedas con todos sus médicos; el de 60 por médico se mantiene.
- **Lecturas de agenda no atómicas** (baja): configuración, citas y bloqueos se leen en consultas separadas; durante el instante de una confirmación una lectura puede ver el estado anterior. Las escrituras no se ven afectadas.
- **Espacios que cruzan un cambio de hora** (baja, solo zonas fronterizas, 2 días al año): la franja se mide en minutos locales y la duración en tiempo real; no hay solapes.
- **Tiempo de respuesta de la búsqueda por correo** distingue cuenta existente de inexistente (oráculo débil ya aceptado).

## Actualización (feature 003, 2026-11-23)

- **Riesgo del boleto de recepción, resuelto.** El vínculo médico-paciente creado por el personal con un boleto ya no es silencioso ni irrevocable: guarda `origin = 'office'` y quién lo creó, la cuenta recibe `patient_linked_by_office` y puede revocarlo desde «Mis consultorios» (cancela sus citas futuras con ese consultorio y retira el acceso al contacto). Tras revocar, el personal no puede agendar a esa cuenta (404) hasta que el propio paciente vuelva a reservar con una nueva autorización. Ver `0004-micrositio.md`.
- **Disponibilidad.** La reserva del paciente llama a `validatePatientBookingWindow` y `listFreeSlots` (`forPatient`) y lleva su prueba de concurrencia (`booking-concurrency.test.ts`).
- **Correos.** `appointment_created` ahora lleva dirección, enlace y `Reply-To`; la regla «sin enlaces» de este documento ya no aplica.
