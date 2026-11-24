# Research: Panel de soporte

Decisiones técnicas y alternativas. Las del producto están en [spec.md](spec.md) y en `docs/decisions/`.

## D1. Dónde vive el estado operativo de la cuenta

- **Decisión**: columna `doctor.account_state ENUM('active','suspended','read_only') NOT NULL DEFAULT 'active'`, con
  `account_state_changed_at` y `account_state_changed_by`. Independiente de `approval_status` (que sigue siendo pendiente,
  aprobado o rechazado).
- **Razón**: son dos preguntas distintas («¿verificamos su cédula?» y «¿puede operar ahora?»). Mezclarlas en un solo enum
  rompería las rutas, pruebas y vistas que ya comparan `approval_status = 'approved'`. El cobro posterior reutilizará la
  misma columna (`read_only` por falta de pago).
- **Alternativas**: ampliar `approval_status` (rechazada: cambia 15 sitios y confunde el flujo de reenvío de cédula); usar solo
  `user.status = 'disabled'` (rechazada: no cubre solo lectura ni a recepción, y mezcla cuenta de acceso con estado de
  negocio).

## D2. Dónde se aplica el estado (tres puntos únicos)

- **Decisión**:
  1. `createTenantResolver.resolve` y `requireApprovedDoctor`: `suspended` → 403 siempre; `read_only` → 403 si el método no es
     `GET` ni `HEAD`. Lo usan el médico y su recepción, así que recepción queda en el mismo estado que el médico.
  2. `isAcceptingBookings` (dentro de la transacción de reserva y de urgencia): exige `account_state = 'active'`.
  3. El micrositio público (`site-resolver` y la consulta de listado) trata a `suspended` y `read_only` como «no acepta
     reservas»: muestra «confirma por teléfono».
- **Razón**: son los puntos por donde ya pasa todo (la prueba `route-audit` obliga a que cada ruta use el resolutor), así que
  no se añaden comprobaciones dispersas. Rechazar por método es una regla simple y verificable: en solo lectura el médico
  consulta pero no cambia nada.
- **Alternativas**: comprobar el estado en cada servicio de escritura (rechazada: ~25 servicios, fácil olvidar uno); una
  lista blanca de rutas de solo lectura (rechazada: más frágil que el método HTTP, y todas las rutas `GET` ya son sin efectos
  por la constitución III).
- **Pacientes**: las rutas de paciente (`/pacientes/...`) no usan el resolutor de médico, así que **cancelar una cita sigue
  funcionando** en ambos estados, como pide la spec.

## D3. Suspender cierra el acceso del médico

- **Decisión**: en la misma transacción que cambia `account_state` a `suspended`, `user.status` del médico pasa a `disabled`
  y se revocan sus sesiones (`session.revoked_at`). Al reactivar vuelve a `active`. `login-service` y `sessions` ya rechazan
  usuarios no activos con la respuesta uniforme.
- **Razón**: reutiliza lo que ya existe y cumple «sus sesiones abiertas se cierran» (SC-003) sin tocar el flujo de acceso.
  Solo lectura **no** deshabilita al usuario.
- **Recepción**: no se deshabilita (puede trabajar con otros médicos); el resolutor le niega el consultorio suspendido.
- **Riesgo**: `user.status = 'disabled'` no se usa para otro fin hoy (se verificó en el código); la prueba de ciclo de vida lo
  fija.

## D4. Historial de soporte de solo anexar

- **Decisión**: tabla `support_action_log` (`id`, `support_user_id`, `action`, `target_type`, `target_id`, `reason`,
  `occurred_at`) con disparadores `BEFORE UPDATE/DELETE` que fallan, igual que `calendar_action_log`. `doctor_review` se
  conserva (lo lee el flujo de reenvío de cédula) y su contenido previo se copia a la tabla nueva en la migración.
- **Acciones**: `approve`, `reject`, `release_cedula`, `suspend`, `read_only`, `reactivate`, `change_slug`, `retry_email`,
  `cancel_email`, `view_cedula`.
- **Razón**: una sola tabla, con una sola consulta paginada y filtrable, que ningún rol puede editar. `calendar_action_log` no
  sirve: pertenece a un médico (`doctor_id NOT NULL`) y es de ese tenant.
- **Alternativas**: ampliar `doctor_review` (rechazada: es por médico y solo cubre decisiones); usar `security_event`
  (rechazada: es por usuario y sin motivo).
- **El cambio de enlace** además mantiene su fila `site_updated` con rol `support` en el registro de la agenda (ya existe).

## D5. Métricas: lo que se calcula y lo que se cuenta

| Métrica | Fuente | Cómo |
|---------|--------|------|
| Correos entregados | `email_outbox` | `deliveryReport` existente (enviados / (enviados + fallidos) del periodo) |
| Urgencias agendadas frente a sin espacio | `calendar_action_log` (`urgent_requested`, `ok` / `rejected`) | conteo del periodo |
| Citas por médico por semana | `appointment` | `COUNT` agrupado por médico y semana (solo conteos, sin pacientes) |
| Médicos activos por semana | `calendar_action_log` con actor médico o recepción | médicos distintos con al menos una acción en la semana |
| **Finalización de reserva** | `pilot_metric_daily` | `started` = el paciente entra a la pantalla de reservar (una vez por visita: los enlaces del calendario llevan la hora de entrada firmada); `completed` = la cita se crea |
| **Tiempo para reservar** | `pilot_metric_daily` | los enlaces y el formulario llevan la hora de entrada firmada; al reservar se suma la duración y se cuenta si fue menor a 2 min |

- **Decisión**: contadores diarios por médico (`day`, `doctor_id`, `started`, `completed`, `duration_sum_seconds`,
  `duration_count`, `under_target_count`), actualizados con `INSERT … ON DUPLICATE KEY UPDATE` (atómico, sin lectura previa).
  La hora de apertura se firma con el secreto CSRF de la sesión (HMAC) y se descarta si la firma no coincide o tiene más de
  60 min.
- **Razón**: sin esto no existe forma de medir la finalización ni el tiempo (el sistema no guarda el momento en que alguien
  abre el formulario). Los contadores no identifican a nadie (constitución I) ni al visitante; son agregados por día y médico.
- **Alternativas**: contar vistas de página por IP (rechazada: dato personal y sobreconteo por robots); un servicio de
  analítica externo (rechazada: tercero y datos de salud); medir solo entre cita creada y la hora de la solicitud (rechazada:
  no es el tiempo del paciente).
- **Metas** (constantes versionadas): finalización > 70 %, tiempo < 2 min (se muestra el porcentaje que cumple), correos
  entregados > 98 %, uso en semana 4 (médicos activos en la semana 4 desde la aprobación del primero ≥ la mitad).
- **Periodos**: última semana, últimas 4 semanas y todo el piloto; sin datos → «sin datos».

## D6. Vista de la cola de correos sin contenido

- **Decisión**: el servicio de soporte consulta `email_outbox` seleccionando **solo** `id`, `template`, `status`, `attempts`,
  `created_at`, `next_attempt_at`, `last_error_code` y el destinatario **enmascarado** (`j***@dominio.com`, calculado en SQL).
  **Nunca** selecciona `payload_ref`; una prueba estática lo comprueba sobre el módulo. Nueva columna
  `email_outbox.last_error_code VARCHAR(40)` con un código cerrado (`smtp_unreachable`, `smtp_rejected`, `smtp_timeout`,
  `template_error`, `other`) que `processOutbox` rellena al fallar, sin texto libre del servidor.
- **Reintentar**: solo `failed`, y solo de tipos sin `sensitiveKeys`; `status = 'queued'`, `attempts = 0`,
  `next_attempt_at = ahora`. **Cancelar**: `failed` o `queued` → `cancelled` (estado existente). `doctor_urgent_notice` fallido
  ya perdió su categoría y encoló el aviso genérico: no se ofrece ninguna acción sobre él.
- **Razón**: cumple FR-016 a FR-018 por construcción (no se puede mostrar lo que nunca se lee).

## D7. Nombre del enlace: panel y reserva

- **Decisión**: `changeSiteSlug` se reutiliza desde el panel (recibe el id de la persona de soporte en lugar del correo; la
  versión de línea de comandos busca el id y llama a la misma función). Se añade `site_slug_reservation (slug, doctor_id,
  reserved_until)`: al cambiar, el nombre anterior se reserva 90 días para su dueño; crear o cambiar a un nombre reservado
  por otro médico se rechaza con «Ese nombre ya está en uso».
- **Razón**: evita que un enlace compartido (impreso o enviado por correo) apunte de pronto a otro consultorio.
- **Alternativas**: redirigir el nombre anterior al nuevo (rechazada: la feature 3 decidió que el anterior deja de resolver);
  reserva indefinida (rechazada: bloquea nombres para siempre).

## D8. Confirmación, motivo e idempotencia de las acciones

- **Decisión**: todo formulario de cambio incluye `reason` (1 a 500 caracteres, texto normalizado), la casilla `confirm = yes`
  y, en cambios de estado, `from` (el estado que la persona vio). El servicio abre una transacción, bloquea la fila del
  médico (`SELECT … FOR UPDATE`), compara `from` con el estado real y, si difiere o la transición no es válida, responde 409
  sin cambiar nada y sin duplicar el historial.
- **Razón**: cubre el doble envío, dos personas actuando a la vez (SC-008) y transiciones inválidas (FR-007) con un solo
  mecanismo, el mismo patrón que `withCalendarLock`.
- **Liberar cédula**: antes del formulario final hay una pantalla `GET` que muestra citas futuras (solo el número) y el estado
  del micrositio; abrirla no cambia nada.

## D9. Datos de médicos bloqueados (FR-023) y de pacientes (FR-022)

- **Decisión**: no se implementa ningún borrado ni anonimización programados; el panel no ofrece botón de borrado. Soporte no
  ve datos de pacientes: ninguna ruta ni consulta del módulo toca las tablas de pacientes, y una prueba estática escanea
  `src/modules/support/` para impedir referencias a ellas (salvo `COUNT` de citas por médico, con lista justificada).
- **Razón**: son decisiones del responsable; el plazo de conservación queda a cargo de la revisión legal (supuesto abierto 2).

## D10. Qué NO se hace

- Sin impersonación (FR-004): no existe ruta que cree una sesión como otro usuario; una prueba recorre las rutas del panel.
- Sin cambiar el estado de cuentas de soporte desde el panel (FR-013): el panel solo lista médicos.
- Sin cron nuevo: las métricas se calculan al abrir; la cola se sigue procesando con `jobs:outbox`.
- Sin ampliar el alcance de datos de pacientes ni creación de cuentas de soporte desde la interfaz.
