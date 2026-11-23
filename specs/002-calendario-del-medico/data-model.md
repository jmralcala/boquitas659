# Data Model: Calendario del médico (agenda)

Migración `0009_calendar.sql`. Compatible con MySQL 8 y MariaDB, horas en UTC (`DATETIME(3)`), sin tipo JSON, sin
campos clínicos ni de triaje (principio I). Las tablas existentes que se usan: `doctor`, `user`, `patient_account`,
`patient`, `doctor_patient`, `reception_membership` y `email_outbox` (feature 1).

## Tablas nuevas

### calendar_settings
Una fila por médico; **si no existe, rigen los valores por defecto** (se crea al primer guardado).

| Campo | Tipo | Regla |
|-------|------|-------|
| `doctor_id` | BIGINT UNSIGNED PK, FK `doctor` | Un calendario por médico |
| `slot_minutes` | SMALLINT UNSIGNED | 15–180 en pasos de 5 (por defecto 45) |
| `gap_minutes` | SMALLINT UNSIGNED | 0–60 en pasos de 5 (por defecto 15) |
| `timezone` | VARCHAR(64) | Una de las zonas permitidas (por defecto `America/Mexico_City`) |
| `min_notice_minutes` | INT UNSIGNED | 0–10 080 (7 días); por defecto 120 |
| `max_advance_days` | SMALLINT UNSIGNED | 1–365; por defecto 60 |
| `updated_at` | DATETIME(3) | |

Reglas entre campos: `min_notice_minutes` < `max_advance_days × 1440`. CHECK de rangos en la tabla además de zod
(MySQL 8.0.16+ y MariaDB 10.2.1+ las aplican).

### calendar_hours
Franjas del horario semanal en hora local del consultorio. Se **reemplazan todas** las del médico al guardar la
configuración (borrar e insertar en la misma transacción con el bloqueo del médico).

| Campo | Tipo | Regla |
|-------|------|-------|
| `id` | BIGINT UNSIGNED PK | |
| `doctor_id` | BIGINT UNSIGNED FK `doctor` | Índice `(doctor_id, weekday, start_minute)` |
| `weekday` | TINYINT UNSIGNED | 1 (lunes) a 7 (domingo) |
| `start_minute` | SMALLINT UNSIGNED | Minutos desde las 00:00 local, múltiplo de 5, 0–1435 |
| `end_minute` | SMALLINT UNSIGNED | Múltiplo de 5, 5–1440, mayor que `start_minute` |

Reglas (validadas por zod, no por la base): máximo 4 franjas por día; las de un día no se solapan; el fin es
posterior al inicio; una franja cabe en el día (sin cruzar medianoche).

### appointment

| Campo | Tipo | Regla |
|-------|------|-------|
| `id` | BIGINT UNSIGNED PK | |
| `doctor_id` | BIGINT UNSIGNED FK `doctor` | Filtro de aislamiento en toda consulta |
| `patient_id` | BIGINT UNSIGNED FK `patient` | Debe estar vinculado al médico (fila en `doctor_patient`) |
| `start_utc` | DATETIME(3) | Inicio del espacio |
| `end_utc` | DATETIME(3) | `start_utc + duración vigente al agendar`; mayor que `start_utc` |
| `status` | ENUM('booked','cancelled') | Por defecto `booked` |
| `kind` | ENUM('regular') | Solo convencionales en esta feature; la feature 4 añadirá el valor de urgencia |
| `created_by_user_id` | BIGINT UNSIGNED FK `user` | Quién la creó |
| `created_by_role` | ENUM('doctor','reception') | |
| `created_at` | DATETIME(3) | |
| `cancelled_by_user_id` | BIGINT UNSIGNED NULL FK `user` | |
| `cancelled_by_role` | ENUM('doctor','reception') NULL | |
| `cancelled_at` | DATETIME(3) NULL | |
| `active_start_utc` | DATETIME(3) **GENERATED** STORED `IF(status = 'booked', start_utc, NULL)` | Respaldo de la invariante |

Índices: `UNIQUE (doctor_id, active_start_utc)` (una cita vigente por inicio; los `NULL` de canceladas no chocan),
`(doctor_id, start_utc)` para listados y solapes, `(patient_id)`. Sin borrado: la cita cancelada se conserva.
La retención y el borrado por derechos del titular siguen sin definir (decisión 0001, supuesto abierto).

### calendar_block

| Campo | Tipo | Regla |
|-------|------|-------|
| `id` | BIGINT UNSIGNED PK | |
| `doctor_id` | BIGINT UNSIGNED FK `doctor` | Índice `(doctor_id, start_utc, end_utc)` |
| `start_utc` / `end_utc` | DATETIME(3) | Rango semiabierto `[inicio, fin)`; `end_utc > start_utc`; duración máxima 366 días; `end_utc` posterior a este momento al crearse |
| `reason` | VARCHAR(200) NULL | Motivo opcional, privado del consultorio (no se muestra a pacientes) |
| `created_by_user_id` | BIGINT UNSIGNED FK `user` | |
| `created_by_role` | ENUM('doctor','reception') | |
| `created_at` | DATETIME(3) | |

Desbloquear **borra** la fila; la constancia queda en `calendar_action_log`.

### calendar_action_log (solo anexar)

| Campo | Tipo | Regla |
|-------|------|-------|
| `id` | BIGINT UNSIGNED PK | |
| `doctor_id` | BIGINT UNSIGNED FK `doctor` | Índice `(doctor_id, occurred_at)` |
| `actor_user_id` | BIGINT UNSIGNED FK `user` | Índice `(actor_user_id, action, occurred_at)` para contar búsquedas |
| `actor_role` | ENUM('doctor','reception') | |
| `action` | ENUM('settings_updated','appointment_created','appointment_cancelled','block_created','block_removed','block_rejected','patient_lookup') | |
| `appointment_id` | BIGINT UNSIGNED NULL | Sin FK (el registro es independiente de los datos) |
| `block_id` | BIGINT UNSIGNED NULL | Sin FK (el bloqueo puede haberse borrado) |
| `outcome` | ENUM('ok','rejected') | `rejected` en bloqueos con conflicto y en búsquedas sin resultado |
| `occurred_at` | DATETIME(3) | |

Disparadores `BEFORE UPDATE` y `BEFORE DELETE` de una sola sentencia que lanzan `SIGNAL SQLSTATE '45000'`, igual que
`patient_access_log`. No guarda nombres, correos ni contenido. **Retención de 90 días** (migración `0010`): el disparador de borrado solo permite borrar filas de más de 90 días y la limpieza periódica las borra.

## Espacio (no es una tabla)

Objeto calculado: `{ startUtc, endUtc, state: 'free' | 'booked' | 'blocked' | 'past', appointmentId? }`.

- Generación por día local: por cada franja del día de la semana, inicios `inicio + k × (duración + intervalo)` con
  `inicio + duración ≤ fin`. Los inicios cuya hora local no existe (salto de verano) se omiten; los duplicados por
  hora repetida se eliminan.
- Estado, en este orden: `past` si el inicio ≤ ahora; `booked` si una cita vigente se solapa con el espacio
  (`cita.start < espacio.end AND cita.end > espacio.start`); `blocked` si un bloqueo se solapa; si no, `free`.
- Citas vigentes que no coinciden con ningún espacio de la configuración actual se muestran aparte, marcadas
  «fuera del horario actual».

## Relaciones

- `doctor` 1—1 `calendar_settings`; `doctor` 1—N `calendar_hours`, `appointment`, `calendar_block`.
- `appointment` N—1 `patient`; el par (`doctor_id`, `patient_id`) debe existir en `doctor_patient` y se crea al
  agendar si falta.
- Los correos se encolan en `email_outbox` con `payload = { appointmentId }`.

## Transiciones de estado

```text
appointment: (nada) ──crear──▶ booked ──cancelar──▶ cancelled        (cancelled es final; sin reprogramación)
calendar_block: (nada) ──crear──▶ existe ──desbloquear──▶ (borrado)
```

Cancelar solo es posible si `end_utc` es posterior a ahora y el estado es `booked`.

## Reglas de integridad (resumen)

1. Toda mutación corre bajo el bloqueo de la fila del médico (`calendar-lock.ts`).
2. Crear cita: espacio válido en la configuración vigente, futuro, sin cita vigente solapada, sin bloqueo solapado,
   paciente vinculado (o con boleto firmado que crea el vínculo).
3. Bloquear: rechazo total si hay citas vigentes con fin posterior a ahora dentro del rango.
4. Cambiar configuración: nunca modifica ni cancela citas ni bloqueos.
5. Toda consulta de estas tablas filtra por `doctor_id` del `TenantContext`.
