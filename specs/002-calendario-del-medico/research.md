# Research: Calendario del médico (agenda)

Fase 0 de `/speckit-plan`. Formato Decision / Rationale / Alternatives. Esta feature no añade dependencias.

## Hallazgos que afectan a la spec

- **Citas existentes y cambios de duración**: si el médico reduce la duración (p. ej. de 45 a 30 min) una cita
  antigua puede solaparse con un espacio nuevo que no empieza a la misma hora (cita 9:00–9:45, espacio nuevo
  9:30–10:00). Un índice único sobre el inicio no lo detecta. **Decisión**: un espacio está *ocupado* si alguna cita
  vigente se solapa con él, y crear una cita revisa el solape de rango (no solo el inicio) dentro del bloqueo del
  médico. La spec ya pide que las citas existentes se conserven; se añade este criterio a sus Supuestos.
- **Citas pasadas dentro de un rango de bloqueo**: un rango que empieza ayer y termina mañana no debe rechazarse
  por una cita de ayer. **Decisión**: solo cuentan como conflicto las citas vigentes cuyo **fin es posterior a este
  momento**. Se añade a los Supuestos de la spec.
- **Alcance máximo**: sin tope, un rango de bloqueo o una cita a décadas de distancia genera consultas enormes.
  **Decisión**: la agenda y la creación de citas por personal admiten fechas hasta 730 días hacia adelante, y un
  bloqueo dura como máximo 366 días. Se añade a los Supuestos de la spec.

## Decisiones

### 1. Espacios derivados, no almacenados
- **Decision**: los espacios se calculan al leer a partir de la configuración vigente. Dentro de cada franja de un
  día, los inicios son `inicio_franja + k × (duración + intervalo)` mientras `inicio + duración ≤ fin_franja`. Un
  espacio dura solo la duración; el intervalo queda como descanso. Se guardan citas (inicio y fin UTC) y bloqueos.
- **Rationale**: cambiar la configuración nunca toca citas ni obliga a migrar filas; no hay espacios huérfanos; la
  feature 3 usa la misma función pura. El estado (libre, ocupado, bloqueado) se deriva de solapes.
- **Alternatives**: materializar espacios por día (cron o al guardar): obliga a regenerar y reconciliar tras cada
  cambio y duplica la fuente de verdad; guardar solo el inicio de la cita y calcular el fin: pierde la duración con
  que se agendó si luego cambia la configuración.

### 2. Zonas horarias sin dependencias
- **Decision**: `src/lib/zoned-time.ts` convierte hora local del consultorio ↔ UTC con `Intl.DateTimeFormat`
  (`timeZone`, `hourCycle: "h23"`). Local→UTC: se estima el desfase de la zona en esa fecha y se verifica con la
  conversión inversa. Si la hora local **no existe** (salto de verano), el espacio no se genera; si es **ambigua**
  (repetición de una hora), se toma la primera ocurrencia y se deduplica por inicio UTC. Zonas permitidas: una lista
  cerrada de zonas de México (`America/Mexico_City`, `Cancun`, `Merida`, `Monterrey`, `Chihuahua`,
  `Ciudad_Juarez`, `Hermosillo`, `Mazatlan`, `Tijuana`, `Matamoros`, `Bahia_Banderas`, `Ojinaga`); el valor por defecto es
  `America/Mexico_City`.
- **Rationale**: Node trae ICU completo; evitar `luxon` o `date-fns-tz` respeta la regla de no instalar sin
  justificar. Casi todo México ya no cambia de hora, pero la frontera sí (Tijuana, Matamoros, Ojinaga, Ciudad Juárez),
  así que las pruebas cubren esos saltos.
- **Alternatives**: `luxon` o `Temporal` (más cómodos, pero dependencia o API aún no estable); permitir cualquier
  zona IANA (amplía casos de prueba sin beneficio para un producto solo para México; se puede abrir después).

### 3. Integridad: bloqueo de la fila del médico + índice único de respaldo
- **Decision**: toda mutación de agenda corre en `withCalendarLock(db, ctx, fn)`: abre transacción, ejecuta
  `SELECT id FROM doctor WHERE id = ? FOR UPDATE` (la fila existe siempre, así que no hay bloqueo de rango vacío) y
  luego revisa y escribe. Respaldo: columna generada
  `active_start_utc = IF(status = 'booked', start_utc, NULL) STORED` con `UNIQUE (doctor_id, active_start_utc)`
  (los `NULL` no chocan, así que las citas canceladas no estorban).
- **Rationale**: un solo bloqueo corto serializa crear, cancelar, bloquear, desbloquear y cambiar configuración del
  mismo médico sin interbloqueos entre ellos; el piloto tiene decenas de operaciones al día. El índice único evita
  la doble reserva aun si un camino futuro olvidara el bloqueo. La lección de la feature 1 aplica: nada de
  `FOR UPDATE` sobre rangos vacíos.
- **Alternatives**: bloquear solo con el índice único (no cubre bloqueos ni solapes de rango); bloqueos de aplicación
  o de nombre (`GET_LOCK`: no sobrevive a varias instancias de forma fiable y complica los reintentos); aislamiento
  `SERIALIZABLE` (más interbloqueos y no portable entre motores).
- **Riesgo/plan B**: si MariaDB en Hostinger rechazara la columna generada indexada, se sustituye por una columna
  normal `active_start_utc` mantenida por el servicio (la prueba de concurrencia sigue válida). Se verifica en el
  despliegue de pruebas junto con los disparadores.

### 4. Bloqueos como rangos que no tocan citas
- **Decision**: `calendar_block(start_utc, end_utc)`, semiabierto `[inicio, fin)`. Un bloqueo de un espacio suelto es
  el rango del espacio. Bloquear: dentro del bloqueo del médico, `SELECT` de citas vigentes con
  `start_utc < fin AND end_utc > inicio AND end_utc > ahora`; si hay alguna, se rechaza **todo** con la lista
  (fecha, hora, nombre del paciente, máximo 50 y el total); si no, se inserta. Desbloquear borra el bloqueo
  completo (queda constancia en el registro de acciones). Los bloqueos pueden solaparse.
- **Rationale**: es exactamente la regla de la constitución 1.1.0; borrar en lugar de marcar evita un estado más y la
  historia queda en el registro de solo anexar.
- **Alternatives**: bloqueo por espacio (una fila por espacio): se desincroniza al cambiar la configuración y
  explota en vacaciones largas; borrado lógico de bloqueos: más consultas sin necesidad.

### 5. Cita para un paciente vinculado o hallado por correo exacto
- **Decision**: el selector ofrece (a) pacientes ya vinculados con el médico y (b) la búsqueda por el correo exacto de
  una cuenta. La búsqueda **no** devuelve datos del paciente sino una lista de nombres y un **boleto firmado**
  (HMAC-SHA256 con `SESSION_SECRET` y prefijo de propósito `calendar-patient:`, ligado a médico, actor, paciente y
  caducidad de 15 min). Al crear la cita, el `patientId` debe estar ya vinculado al médico **o** venir con un boleto
  válido; en ese caso se crea el vínculo en la misma transacción con `linkPatientToDoctor`. Límite: 30 búsquedas por
  hora por persona y 60 por médico, contados desde `calendar_action_log`.
- **Rationale**: sin boleto, cualquiera con acceso a la agenda podría vincular pacientes recorriendo identificadores
  numéricos (los `patient.id` son consecutivos). El conteo desde el registro es compartido entre instancias y no
  añade infraestructura; los intentos sin resultado también cuentan.
- **Riesgo aceptado (2026-11-22)**: la búsqueda revela los nombres de los pacientes de una cuenta (menores incluidos) y
  que la cuenta existe, a personal sin relación previa. Se acepta como el oráculo del alta de paciente de la feature 1;
  lo mitigan el correo exacto, el límite y el registro.
- **Alternatives**: aceptar cualquier `patientId` (permite enumerar y vincular a todos); límite en memoria con
  `@fastify/rate-limit` (por instancia, ya anotado como deuda); mostrar el teléfono o la fecha de nacimiento al
  elegir (datos que el médico aún no tiene derecho a ver sin relación).

### 6. Correos: dos plantillas reutilizando el outbox
- **Decision**: `appointment_created` y `appointment_cancelled`, con `payload = { appointmentId }`. Destinatario: el
  correo de la cuenta del paciente (también para menores: es la cuenta del tutor). Se encolan **dentro de la misma
  transacción** que la mutación, de modo que no existe una cita sin su aviso encolado ni un aviso de una cita que no
  se creó. `appointment_created` lleva `shouldSend` (con `FOR UPDATE` sobre la cita): si ya se canceló, no se envía.
  Sin enlaces de acción; sin datos clínicos; el asunto no lleva datos personales.
- **Rationale**: es el patrón de feature 1 (at-least-once, cancelación dentro de la transacción de envío).
- **Alternatives**: enviar al `patient.email` propio: es opcional y puede no existir; enviar fuera de la
  transacción: puede dejar la cita sin aviso si el proceso muere entre ambos pasos.

### 7. Registro de acciones de solo anexar
- **Decision**: `calendar_action_log` (quién, rol, médico, acción, id de cita o bloqueo, resultado, hora) con los
  mismos disparadores de solo anexar que `patient_access_log`. Acciones: `settings_updated`, `appointment_created`,
  `appointment_cancelled`, `block_created`, `block_removed`, `block_rejected`, `patient_lookup`. No guarda
  contenido, nombres ni correos.
- **Rationale**: cumple FR-032 y la constitución II (cada acción de recepción registra quién la hizo); reutiliza el
  patrón y el plan B para disparadores.
- **Alternatives**: columnas `created_by`/`cancelled_by` solamente: no cubren configuración, bloqueos borrados ni
  búsquedas.

### 8. Vistas y navegación
- **Decision**: HTML en el servidor con enlaces de navegación día/semana (`/agenda/dia/AAAA-MM-DD`,
  `/agenda/semana/AAAA-MM-DD`); todas las fechas de la URL son fechas locales del consultorio; los formularios
  mandan fecha y hora locales y el servidor las convierte a UTC con la zona del médico. Sin JavaScript obligatorio.
- **Rationale**: coherente con la feature 1 y con hosting simple; evita errores de zona del navegador.
- **Alternatives**: calendario con JavaScript (librería de calendario): dependencia y superficie extra sin
  necesidad para un piloto.

### 9. Disponibilidad para la feature 3
- **Decision**: `availability.ts` exporta (sin rutas) las funciones que la feature 3 usará: espacios libres de un
  rango con las anticipaciones del médico aplicadas, y la comprobación en el servidor de una reserva de paciente
  (mínima, máxima, espacio válido y libre). El personal de la clínica no pasa por las anticipaciones (solo por
  "espacio futuro y libre").
- **Rationale**: una sola fuente de verdad para "qué es reservable"; la constitución exige que el servidor compruebe
  las anticipaciones en cada reserva.
- **Alternatives**: dejar toda la lógica a la feature 3: duplicaría la generación de espacios.

## Pruebas obligatorias (constitución V)

- Concurrencia: 20 creaciones simultáneas del mismo espacio (solo una prospera); bloqueo contra creación (nunca
  ambos); cancelación contra creación; bloqueo contra bloqueo solapado.
- Aislamiento: cada ruta con un médico ajeno responde 404; recepción revocada, 403 en la misma petición.
- Reglas puras: generación de espacios con intervalo, varias franjas, último espacio incompleto, cambio de hora
  (hueco y repetición), cambios de configuración con citas existentes (incluido el solape tras reducir la duración).
- Registro: cada acción deja su fila; la tabla rechaza UPDATE y DELETE; búsquedas limitadas.
