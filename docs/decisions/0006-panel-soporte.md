# 0006 · Panel de soporte

Estado: implementado (feature 005), pendientes el recorrido manual con una persona de soporte real y la medición en el piloto. Fecha: 2026-11-24.
Origen: `specs/005-panel-de-soporte/` (spec, plan, research, data-model, contratos, quickstart), `0001-resumen-grill-me.md` (alcance del piloto y supuestos 2 y 10) y la constitución v1.1.0 (principios I, II, IV y VI).

## Decisiones técnicas

- **Estado operativo de la cuenta** = `doctor.account_state` (`active`, `suspended`, `read_only`), separado de `approval_status`. Se aplica en tres puntos únicos: el resolutor de médico y las guardas (`assertAccountAllows`), `isAcceptingBookings` (reservas y urgencias, dentro de la transacción) y la búsqueda pública del micrositio. Solo lectura rechaza todo lo que no sea `GET`/`HEAD`, incluida la búsqueda de pacientes por POST (`/agenda/citas/buscar`): sin agendar no hace falta. Las páginas del médico y de su recepción lo avisan arriba.
- **Suspender** deshabilita al usuario médico (`user.status = 'disabled'`) y revoca sus sesiones en la misma transacción; **reactivar** lo restablece. Recepción no se deshabilita (puede trabajar con otros médicos): el resolutor, la lista de consultorios y las invitaciones excluyen a los médicos suspendidos. Los pacientes siguen pudiendo cancelar en ambos estados y las citas se conservan.
- **Acciones de cambio**: motivo (1 a 500 caracteres), casilla `confirm` y el estado visto (`from`). Una transacción bloquea la fila del médico y compara `from` con el real: un doble clic o dos personas de soporte producen una sola transición (409 `state_changed` para la segunda).
- **Historial** = `support_action_log`, de solo anexar (disparadores), con autor, acción, objetivo, motivo y fecha; se escribe en la misma transacción que el cambio y recibió el historial previo de `doctor_review`. Consultar el archivo de la cédula también se registra (`view_cedula`) y, si el registro falla, no se entrega el archivo. Es la única excepción a «un GET no cambia estado».
- **Cola de correos sin contenido**: la consulta nunca selecciona `payload_ref`; el destinatario se enmascara en SQL (`j***@dominio`) y el motivo del fallo es un código cerrado (`email_outbox.last_error_code`). Los tipos con claves sensibles (aviso de urgencia) no se reintentan ni se cancelan desde el panel.
- **Enlaces**: el cambio de nombre pasa al panel con el mismo servicio que el procedimiento de línea de comandos; el nombre anterior queda reservado 90 días para su dueño (`site_slug_reservation`) y se avisa al médico con el enlace nuevo.
- **Métricas**: se calculan al abrir la pantalla. Lo que ya existía (correos, urgencias, citas, actividad) se lee de sus tablas; la finalización y el tiempo de reserva se miden con contadores diarios por médico (`pilot_metric_daily`) sin identificar a nadie. La **entrada a la pantalla de reservar** cuenta una vez; los enlaces del calendario llevan la hora de entrada firmada (HMAC con el secreto CSRF de la sesión), así que navegar entre días no vuelve a contar. La reserva suma su duración **después** de confirmarse y fuera del bloqueo del calendario: una falla del contador nunca deshace ni impide una reserva.
- **Liberar cédula** muestra antes el número de citas futuras y el estado del micrositio, avisa al médico con el texto fijo ya existente y es idempotente ante el doble envío.

## Valores y límites

| Valor | Límite |
|-------|--------|
| Motivo de una acción | 1 a 500 caracteres, con la advertencia de no escribir datos de pacientes |
| Lectura del panel | 120 por minuto por IP |
| Cambios del panel | 30 por hora por IP |
| Reserva del enlace anterior | 90 días |
| Hora de entrada firmada | vale 60 minutos |
| Historial y correos fallidos | 50 por página |
| Metas del piloto | finalización > 70 %, reservar < 2 min, correos > 98 %, uso sostenido ≥ 50 % |

## Riesgos abiertos

- **El panel es un rol de plataforma, no un tenant.** No usa contexto de médico y por eso no puede tocar datos de pacientes; una prueba estática lo vigila (`support-isolation`). Las citas solo se **cuentan**.
- **Motivos de texto libre.** Una persona de soporte podría escribir datos de un paciente en el motivo; se mitiga con la advertencia del formulario y porque el historial solo lo ve soporte.
- **Medición aproximada.** «Entrar a la pantalla de reservar» incluye a quien solo mira; el tiempo se mide desde esa entrada. Un paciente que abre dos pestañas cuenta dos entradas. Es una medida del piloto, no un seguimiento de personas.
- **Límite por IP en memoria**, igual que el resto de la aplicación: con varias instancias se multiplica (los límites de cambios son por IP y no por cuenta).
- **Conservación sin plazo.** No hay borrado ni anonimización programados de médicos bloqueados (decisión del responsable, FR-023); el plazo definitivo lo fija la revisión legal.
- **Soporte sin datos de pacientes** (FR-022): los reclamos de un paciente se resuelven con su médico; se revisa después del piloto.
- **Textos de los avisos al médico provisionales** hasta la revisión legal.
- **MariaDB y Hostinger.** La migración `0014` y los disparadores de solo anexar están probados en MySQL 8; falta repetirlos en MariaDB (validación manual).
