# 0004 · Micrositio del médico y reserva del paciente

Estado: implementado (feature 003), pendiente solo el recorrido manual (T071). Fecha: 2026-11-23.
Origen: `specs/003-micrositio-y-reserva-del-paciente/` (spec, plan, research, data-model, contratos, quickstart) y constitución v1.1.0 (principios I a IV).

## Decisiones técnicas

- **Enlace público `/c/<nombre>`.** Nombre único, 3 a 40 caracteres, minúsculas sin acentos, números y guiones; el primero que lo registra se queda con él. Sin lista de palabras reservadas. El médico lo elige una vez y no puede cambiarlo: el cambio lo hace soporte con `npm run support:change-slug` (pide confirmación y deja `site_updated` con rol `support` en el registro de acciones). El resolutor exige formato válido y coincidencia exacta (la colación de la base no distingue mayúsculas).
- **Estados del micrositio.** `draft`, `published`, `unpublished`. `first_published_at` distingue «nunca publicado» (404, igual que una ruta inexistente) de «despublicado o médico sin aprobación» (aviso de confirmar por teléfono con el consultorio, sin reservas). No hay directorio ni índice; todas las pantallas llevan `noindex` y `X-Robots-Tag`.
- **Contexto de paciente.** `createPatientContext` solo lo produce `site-resolver`, tras resolver el médico **desde el nombre del enlace** y comprobar la sesión de paciente. Un `doctorId` del cliente nunca se usa. Las funciones del personal exigen `StaffContext`, así que el compilador impide pasarles un contexto de paciente.
- **Reserva (`reserveAsPatient`).** Una transacción bajo `withCalendarLock` (bloqueo de la fila del médico) con este orden: consultorio publicado y médico aprobado → paciente de la cuenta → espacio existente → doble envío (misma cuenta, mismo paciente y horario: devuelve la cita) → límites por cuenta → horario libre y anticipaciones con `validatePatientBookingWindow` → autorización de datos → vínculo → inserción → correos. Respaldo: índice único `(doctor_id, active_start_utc)`. La validación común a personal y paciente es `assertSlotBookable`.
- **Autorización de datos y vínculo.** `data_authorization` es de solo anexar (cuenta, consultorio, quién, versión vigente del aviso, fecha). Se pide la casilla sin marcar cuando no hay una autorización posterior a la última revocación (primera vez, vínculo creado por el personal, o tras revocar). `doctor_patient` guarda `origin` (`patient`/`office`), `created_by_user_id` y `revoked_at`.
- **Revocar el vínculo (opción A).** Por cuenta y consultorio, en una transacción con el bloqueo del médico: cancela las citas futuras de todos los pacientes de la cuenta con ese consultorio (aviso al médico por cada una y constancia al paciente), marca `revoked_at` en todos sus vínculos y registra `link_revoked`. El consultorio deja de ver el contacto (404 en el detalle del paciente) pero conserva el nombre en las citas pasadas. El personal no puede reactivar ni agendar a una cuenta que revocó; solo el propio paciente, al reservar con una nueva autorización.
- **Cancelación por el paciente.** Hasta `cancel_notice_hours` antes de la cita (0 a 168, por defecto 24; borde inclusivo), configurable por médico. Funciona aunque el micrositio se haya despublicado o el médico ya no esté aprobado. Fuera del plazo se muestra el teléfono del consultorio. No hay reprogramación: se cancela y se reserva de nuevo.
- **Enlaces de correo.** El token (propósito `appointment_confirmation` o `appointment_reminder`, ligado a la cita) nace al enviar; el registro dura 400 días pero la vigencia efectiva termina al cancelarse la cita o llegar su hora. `GET /citas/enlace/<token>` valida **sin consumir** (lo abren los clientes de correo y antivirus); cancelar es un `POST` con CSRF y sesión de la cuenta dueña, y consume el token. Cualquier enlace que no sirva responde el mismo 410 genérico.
- **Recordatorio.** Se encola desde el job `jobs:outbox` (cron por minuto) a `inicio − (límite de cancelación + 6 h)`, una sola vez por cita (`UPDATE … WHERE reminder_enqueued_at IS NULL`), solo para citas vigentes y reservadas antes de ese momento.
- **Correos.** Salen del remitente de la plataforma con el médico como `Reply-To`. El aviso al médico va al correo de su cuenta (no a recepción) y solo lleva el nombre del paciente. El outbox guarda solo `{ appointmentId }` (y `reason` en la revocación).
- **Logo.** PNG, JPEG o WebP validado por firma de bytes (no por extensión ni `Content-Type`), hasta 1 MB, guardado fuera de la raíz pública (`LOGO_STORAGE_DIR`) y servido por la aplicación.
- **Mapa.** Iframe de Google Maps Embed solo si hay `GOOGLE_MAPS_EMBED_KEY`; la CSP añade `frame-src https://www.google.com` únicamente en la página del micrositio. Sin clave se muestra la dirección en texto.

## Valores y límites

| Valor | Límite |
|-------|--------|
| Reservas por cuenta | 5 por hora (con cualquier consultorio) |
| Citas vigentes | 3 por paciente y consultorio |
| Cancelaciones por cuenta | 10 por hora |
| Reservas / cancelaciones por IP | 20 / 30 por hora |
| Entrada y alta desde el micrositio | 10 por minuto por IP (y la espera creciente por cuenta de `/login`) |
| Enlaces de correo | 60 por minuto por IP |
| Micrositio público | 120 por minuto por IP |
| Retención del registro de acciones | 90 días (sin cambio) |

## Riesgos abiertos

- **El alta revela si un correo existe.** «Ya soy paciente» distingue cuenta de paciente existente de inexistente para ofrecer «Primera cita». Aceptado en la especificación; lo mitigan la espera creciente por cuenta e IP y el límite de 10 por minuto.
- **Mapa de un tercero.** Google recibe la dirección del consultorio y la IP del visitante; el gasto se acota con la restricción por referente y la cuota diaria de la clave (hay que configurarlas en la consola del proveedor).
- **Límites por IP en memoria.** Los límites de peticiones por IP viven en el proceso (`@fastify/rate-limit`): con varias instancias se multiplican. Los límites por cuenta sí se cuentan en la base y son exactos bajo el bloqueo.
- **Cambio del nombre del enlace.** Es manual (soporte) y deja el enlace anterior sin efecto; el médico debe repartir el nuevo.
- **Correos con nombre del médico.** El `Reply-To` expone el correo de la cuenta del médico al paciente (decisión de producto para que pueda contestarle).
- **MariaDB y Hostinger.** La migración `0011` (disparadores de solo anexar, `ALTER` de enumeraciones y llaves) y los escenarios de concurrencia están probados en MySQL 8; falta repetirlos en MariaDB (T071).
- **Boletos de recepción (feature 2).** El vínculo creado por el personal con boleto ya no es silencioso: la cuenta recibe `patient_linked_by_office` y puede revocarlo; ver `0003-calendario.md`.
