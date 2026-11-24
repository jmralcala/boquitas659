# Data Model: Panel de soporte

Migración `migrations/0014_support_panel.sql`. Todas las horas en UTC (`DATETIME(3)`). No se guarda ningún dato de pacientes ni
la categoría de urgencia en estas estructuras.

## Cambios a tablas existentes

### `doctor`

| Columna | Tipo | Regla |
|---------|------|-------|
| `account_state` | `ENUM('active','suspended','read_only') NOT NULL DEFAULT 'active'` | Estado operativo de la cuenta; independiente de `approval_status` |
| `account_state_changed_at` | `DATETIME(3) NULL` | Última transición |
| `account_state_changed_by` | `BIGINT UNSIGNED NULL` | FK a `user(id)`: persona de soporte que la hizo |

Transiciones válidas (solo para `approval_status = 'approved'`; cualquier otra se rechaza con 409 y sin cambios):

```
active ──suspender──▶ suspended        suspended ──reactivar──▶ active
active ──solo lectura─▶ read_only      read_only ──reactivar──▶ active
read_only ──suspender─▶ suspended
```

- Un médico no aprobado (pendiente o rechazado) no tiene estado operativo que cambiar: su acceso ya lo gobierna
  `approval_status`.
- Al liberar una cédula la cuenta queda `rejected`; `account_state` **no cambia** (al volver a aprobarse conserva el que tenía).
- Efectos de `suspended`: `user.status = 'disabled'` del médico y sesiones revocadas; el resolutor niega a su recepción; el
  micrositio no acepta reservas ni urgencias.
- Efectos de `read_only`: el resolutor y las guardas rechazan todo lo que no sea `GET`/`HEAD`; el micrositio no acepta
  reservas ni urgencias; los pacientes pueden cancelar.

### `email_outbox`

| Columna | Tipo | Regla |
|---------|------|-------|
| `last_error_code` | `VARCHAR(40) NULL` | Código cerrado del último fallo: `smtp_unreachable`, `smtp_rejected`, `smtp_timeout`, `template_error`, `other`. Nunca texto del servidor ni datos |

### `calendar_action_log`

Sin cambios de estructura; las urgencias `urgent_requested` y los `site_updated` con rol `support` ya existen.

## Tablas nuevas

### `support_action_log` (solo anexar)

| Columna | Tipo | Regla |
|---------|------|-------|
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | PK |
| `support_user_id` | `BIGINT UNSIGNED NOT NULL` | FK a `user(id)`; quien actuó |
| `action` | `ENUM('approve','reject','release_cedula','suspend','read_only','reactivate','change_slug','retry_email','cancel_email','view_cedula')` | Tipo de acción |
| `target_type` | `ENUM('doctor','site','email')` | Qué se tocó |
| `target_id` | `BIGINT UNSIGNED NOT NULL` | Id del médico, del micrositio (= id del médico) o del correo |
| `reason` | `VARCHAR(500) NULL` | Motivo interno; nulo solo en `view_cedula` |
| `occurred_at` | `DATETIME(3) NOT NULL` | |

- Índices: `(occurred_at, id)` para la lista; `(support_user_id, occurred_at)`; `(action, occurred_at)`.
- Disparadores `BEFORE UPDATE` y `BEFORE DELETE` que lanzan `SQLSTATE '45000'` (igual que `calendar_action_log`).
- La migración copia las filas de `doctor_review` (`approved`, `rejected`, `cedula_released`) con su autor y fecha.
- **Nunca** guarda contenido de correos, categorías, datos de pacientes ni el valor de la cédula.

### `site_slug_reservation`

| Columna | Tipo | Regla |
|---------|------|-------|
| `slug` | `VARCHAR(40) NOT NULL` | PK; mismo formato y longitud que `doctor_site.slug` |
| `doctor_id` | `BIGINT UNSIGNED NOT NULL` | FK a `doctor(id)`; el único que puede volver a usarlo |
| `reserved_until` | `DATETIME(3) NOT NULL` | Cambio + 90 días |

- Al cambiar un enlace se inserta (o se actualiza) el nombre anterior. Al crear o cambiar un enlace se rechaza un nombre
  reservado por otro médico mientras `reserved_until > ahora`. Las filas vencidas se ignoran (no hace falta limpiarlas).

### `pilot_metric_daily`

| Columna | Tipo | Regla |
|---------|------|-------|
| `day` | `DATE NOT NULL` | Día en UTC |
| `doctor_id` | `BIGINT UNSIGNED NOT NULL` | PK compuesta con `day`; FK a `doctor(id)` |
| `started` | `INT UNSIGNED NOT NULL DEFAULT 0` | Formularios de reserva abiertos con un espacio elegido |
| `completed` | `INT UNSIGNED NOT NULL DEFAULT 0` | Reservas creadas desde ese formulario |
| `duration_sum_seconds` | `BIGINT UNSIGNED NOT NULL DEFAULT 0` | Suma de duraciones (apertura → reserva) |
| `duration_count` | `INT UNSIGNED NOT NULL DEFAULT 0` | Reservas con duración válida |
| `under_target_count` | `INT UNSIGNED NOT NULL DEFAULT 0` | Reservas con duración menor a 2 minutos |

- Se actualiza con `INSERT … ON DUPLICATE KEY UPDATE` (incremento atómico). Sin identificadores de persona, sesión ni IP.
- Una duración mayor a 60 minutos, negativa o con firma inválida no se cuenta en `duration_*` (sí en `completed`).

## Entidades derivadas (no se guardan)

- **Resumen de la cola de correos**: conteos por estado, antigüedad del pendiente más viejo y filas de fallidos con `id`,
  `template`, destinatario enmascarado, `attempts`, `created_at`, `last_error_code`.
- **Métrica del piloto**: valor, meta, cumplimiento y «sin datos» para un periodo.
- **Vista previa de liberación**: número de citas futuras vigentes del médico y estado de su micrositio (solo conteos).

## Validaciones (zod en la frontera)

- `reason`: texto recortado de 1 a 500 caracteres; `confirm`: literal `yes`; `from`: enum de estados.
- `id` de rutas: entero positivo; `q` (búsqueda): hasta 100 caracteres con los comodines `%` y `_` escapados.
- `periodo`: `semana` | `4semanas` | `piloto`. Filtros del historial: `persona` (entero), `accion` (enum), `desde` y `hasta` (`YYYY-MM-DD`, desde ≤ hasta).
- `slug` nuevo: las mismas reglas de `site-slug` (formato, longitud, unicidad y reservas).
- Paginación: `pagina` entero ≥ 1; tamaño fijo de 50.
