# Data Model: Urgencias y triaje

Sin tablas nuevas. Todo es ampliar tablas de las features 2 y 3 (migración `0013_urgent.sql`, compatible con MySQL 8 y
MariaDB). **Principio I: no hay ninguna columna que guarde la categoría del triaje ni las señales de alarma.**

## Cambios a tablas existentes

### appointment
| Campo | Cambio | Regla |
|-------|--------|-------|
| `kind` | `ENUM('regular')` → `ENUM('regular','urgent')` | Es lo único que se guarda del triaje. Por defecto `regular`. Lo fija el servidor (nunca el cliente): `urgent` solo desde `requestUrgent`. |

Sin índices nuevos: el de cita vigente `(doctor_id, active_start_utc)` ya respalda la invariante de «sin doble reserva» también
para urgencias; `idx_appointment_patient` sirve para «una urgencia activa por paciente».

### calendar_hours
| Campo | Cambio | Regla |
|-------|--------|-------|
| `kind` | `ENUM('regular','urgent') NOT NULL DEFAULT 'regular'` | Las franjas existentes quedan `regular`. |

El índice `idx_calendar_hours_doctor (doctor_id, weekday, start_minute)` se mantiene. Reglas (validadas con zod y repetidas
en el servidor al guardar; los CHECK existentes de minutos siguen valiendo):
- hasta 4 franjas `regular` por día (como hoy) y hasta **2** franjas `urgent` por día;
- una franja `urgent` no se solapa con otra franja (de cualquier tipo) del mismo día;
- no cruzan la medianoche; minutos múltiplos de 5.

### calendar_settings
| Campo | Cambio | Regla |
|-------|--------|-------|
| `urgent_min_notice_minutes` | `INT UNSIGNED NOT NULL DEFAULT 30` | `CHECK (urgent_min_notice_minutes BETWEEN 0 AND 1440)`. Solo el médico la cambia (no recepción). |

### calendar_action_log
| Campo | Cambio | Regla |
|-------|--------|-------|
| `action` | + valor `'urgent_requested'` | `outcome = 'ok'` con `appointment_id` cuando se agendó; `outcome = 'rejected'` sin cita cuando no hubo espacio. `actor_user_id` y `actor_role = 'patient'` identifican a la cuenta. **Nunca** lleva categoría. Sigue de solo anexar y con retención de 90 días. |

Consulta del límite: filas de `urgent_requested` de `actor_user_id` con `occurred_at >= ahora − 24 h`. Ya la cubre el índice
`idx_calendar_log_actor (actor_user_id, action, occurred_at)` de la migración `0009`: no se añade ninguno.

## Datos que NO cambian de estructura

### email_outbox
Se reutiliza tal cual. La categoría vive **solo** en `payload_ref` de las filas `doctor_urgent_notice`:

| Estado de la fila | Qué pasa con `category` |
|-------------------|-------------------------|
| `queued` | Presente (máximo 24 h). |
| `sent` | Eliminada en la misma transacción que marca el envío. |
| `cancelled` (la urgencia se canceló antes de enviarse) | Eliminada al cancelar. |
| `failed` (reintentos agotados) | Eliminada; se encola `doctor_urgent_generic` (sin categoría). |
| `queued` con más de 24 h | El job `urgent-notices` la elimina y convierte la fila en `doctor_urgent_generic`. |

## Datos en código (no en base de datos)

### Contenido del triaje (`src/modules/urgent/triage-content.ts`)
- `version`: texto de versión que se muestra junto al aviso.
- `reviewedByDentist`: `false` mientras sea provisional (bloquea el flujo en producción).
- Categorías (lista fija, orden de gravedad): `id` (`rojo`, `naranja`, `amarillo`, `verde_claro`, `verde`), nombre del semáforo,
  texto de la opción, `windowHours` (2, 12, 24, 48, 72) y si muestra el aviso de hospital.
- Señales de alarma: `dificultad_respirar_tragar`, `hinchazon_ojo`.
- Textos provisionales de primeros auxilios y del aviso de hospital.

## Entidades de la spec y dónde viven

| Entidad de la spec | Dónde vive |
|--------------------|------------|
| Cita de urgencia | `appointment` con `kind = 'urgent'` |
| Horario de urgencia | `calendar_hours` con `kind = 'urgent'` |
| Configuración de urgencias | `calendar_settings.urgent_min_notice_minutes` + las franjas anteriores |
| Solicitud de urgencia (contador) | `calendar_action_log` (`urgent_requested`) |
| Aviso de urgencia en cola | `email_outbox` (`doctor_urgent_notice`) |
| Contenido del triaje (versionado) | `triage-content.ts` |

## Relaciones y reglas de integridad

- Una urgencia es una cita normal: pertenece a un médico y a un paciente de una cuenta, tiene los mismos estados (`booked`,
  `cancelled`) y el mismo índice único de cita vigente.
- La cita de urgencia crea o reutiliza `doctor_patient` con la autorización de datos de la feature 3 en la misma transacción.
- Un paciente tiene a lo sumo **una** cita `urgent` vigente que no ha empezado (comprobado bajo el bloqueo del médico; entre
  consultorios distintos puede coexistir por una carrera extremadamente improbable: se acepta y se documenta).

## Transiciones de estado

```text
solicitud:  (formulario) ──alarma──▶ pantalla de emergencia (nada se guarda)
            (formulario) ──CAPTCHA no válido/no disponible──▶ rechazo o «llama al médico» (nada se guarda ni se cuenta)
            (formulario) ──límite──▶ rechazo (nada se guarda ni se cuenta)
            (formulario) ──sin espacio──▶ urgent_requested rechazada (cuenta para las 3 por 24 h), sin cita ni aviso
            (formulario) ──con espacio──▶ cita urgent booked + urgent_requested ok + 2 correos en cola
appointment: booked ──cancelar (paciente, sin plazo; o consultorio)──▶ cancelled
outbox:      doctor_urgent_notice queued ──enviado──▶ sent (sin categoría)
                                          ──cancelada la cita──▶ cancelled (sin categoría)
                                          ──reintentos agotados──▶ failed (sin categoría) + doctor_urgent_generic
                                          ──24 h──▶ doctor_urgent_generic (sin categoría)
```
