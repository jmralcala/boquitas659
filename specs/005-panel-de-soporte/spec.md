# Feature Specification: Panel de soporte

**Feature Branch**: `005-panel-de-soporte` (sin rama propia: el trabajo sigue en `main`)

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Feature 5: Panel de soporte. Herramienta de administración interna para el personal de soporte de la plataforma (rol de soporte ya existente con doble factor, feature 1) durante el piloto de 3 a 5 médicos. Incluye: ver y gestionar cuentas de médicos (activación manual sin cobro durante el piloto, aprobación o rechazo de la verificación, suspensión y modo solo lectura, reactivación), liberar una cédula registrada por error o por otra persona, consultar el estado de los micrositios, ver el estado de la cola de correos sin exponer el contenido ni la categoría de urgencias y consultar el registro de acciones del propio soporte. Reglas: todo acceso de soporte requiere doble factor y queda auditado; soporte no ve datos clínicos ni de pacientes salvo lo mínimo indispensable y nunca la categoría del triaje; las acciones que cambian el estado piden confirmación y motivo; sin impersonación de médicos. Métricas del piloto agregadas y sin datos personales: finalización de reserva, tiempo para reservar, correos entregados, urgencias con espacio frente a sin espacio, citas por médico por semana. Fuera de alcance: WhatsApp, cobro con Openpay, historial clínico, reprogramación, registro abierto."

## Contexto y estado actual

Las features 1 y 3 ya dejaron una **vista mínima de soporte**: lista de médicos por estado de aprobación, detalle con la cédula, aprobar, rechazar con motivo y liberar una cédula, y un procedimiento por línea de comandos para cambiar el nombre del enlace de un micrositio. Esta feature convierte esa vista mínima en el **panel de soporte del piloto**: añade el ciclo de vida completo de la cuenta del médico (suspender, solo lectura, reactivar), el estado de los micrositios y de la cola de correos, las métricas agregadas del piloto y la consulta del registro de acciones, sin ampliar lo que soporte puede ver de los pacientes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Soporte gestiona el ciclo de vida de la cuenta de un médico (Priority: P1)

El personal de soporte abre la lista de médicos, entra al detalle de uno y puede aprobarlo o rechazarlo (ya existe), **suspender** su cuenta, ponerla en **solo lectura** o **reactivarla**. Cada cambio pide un motivo y una confirmación explícita, se registra (quién, qué, cuándo y motivo) y avisa por correo al médico con un texto fijo que no revela el motivo interno. Un médico suspendido no entra a su cuenta, y su micrositio deja de aceptar reservas y urgencias. Un médico en solo lectura entra y consulta su agenda, pero no puede cambiar nada (citas, bloqueos, configuración ni publicación) y su micrositio no acepta reservas nuevas; las citas ya agendadas se conservan y sus pacientes aún pueden cancelarlas.

**Why this priority**: sin esto soporte no puede operar el piloto: activar manualmente a un médico sin cobro, frenar una cuenta problemática o devolverla a la normalidad. Es lo que reemplaza al cobro durante el piloto.

**Independent Test**: con un médico aprobado, suspenderlo, comprobar que no puede entrar y que su micrositio no acepta reservas; reactivarlo y comprobar que todo vuelve; repetir con solo lectura y comprobar que consulta pero no modifica.

**Acceptance Scenarios**:

1. **Given** un médico aprobado y activo, **When** soporte lo suspende indicando un motivo y confirmando, **Then** el médico ya no puede iniciar sesión (sus sesiones abiertas se cierran), su micrositio muestra que confirme por teléfono con el consultorio, se registra la acción y se le avisa por correo.
2. **Given** un médico suspendido, **When** soporte lo reactiva con motivo, **Then** recupera el acceso y su micrositio vuelve a su estado anterior (publicado o no), y se le avisa por correo.
3. **Given** un médico activo, **When** soporte lo pone en solo lectura, **Then** el médico puede ver su agenda y sus citas pero toda acción de cambio le es rechazada con un mensaje claro, y el micrositio no acepta reservas ni urgencias nuevas.
4. **Given** un médico en solo lectura con citas futuras, **When** un paciente intenta cancelar una de ellas, **Then** la cancelación procede como siempre y el espacio queda libre.
5. **Given** cualquier cambio de estado, **When** soporte envía la acción sin motivo o sin confirmar, **Then** no se aplica nada y se muestra qué falta.
6. **Given** un médico pendiente de aprobación, **When** soporte lo aprueba, **Then** empiezan sus 5 días de prueba como hoy; durante el piloto la prueba no pasa a un estado de cobro ni a solo lectura de forma automática: solo soporte cambia el estado.
7. **Given** una cuenta de médico, **When** soporte intenta una acción que no corresponde a su estado (por ejemplo reactivar a quien está activo), **Then** se rechaza sin cambios.

---

### User Story 2 - Soporte vigila la salud operativa: micrositios y cola de correos (Priority: P2)

Soporte ve, por médico y en conjunto, el **estado de cada micrositio** (borrador, publicado o despublicado, con su nombre de enlace) y el **estado de la cola de correos**: cuántos hay pendientes, enviados y fallidos, la antigüedad del más viejo pendiente, y por correo fallido el tipo de mensaje, la fecha, el número de intentos y un motivo técnico genérico. Nunca ve el contenido, el destinatario completo, los datos de pacientes ni la categoría de una urgencia. Puede **reintentar** un correo fallido y **cancelarlo**, con motivo, salvo los de urgencia, cuya categoría ya se eliminó al fallar y que se reemplazan por el aviso genérico. Soporte puede también **cambiar el nombre del enlace** de un micrositio desde el panel (hoy es solo por línea de comandos), con las mismas reglas de unicidad.

**Why this priority**: el piloto depende de que los correos lleguen (confirmaciones, recordatorios y avisos de urgencia en menos de 3 minutos); soporte necesita ver cuándo algo se atora antes de que lo reporte un médico.

**Independent Test**: dejar correos pendientes y fallidos, abrir el panel y comprobar los conteos y que no aparece ningún contenido ni categoría; reintentar un fallido y comprobar que sale; cambiar el nombre del enlace de un micrositio y comprobar que el nuevo funciona y el anterior deja de funcionar.

**Acceptance Scenarios**:

1. **Given** correos pendientes, enviados y fallidos, **When** soporte abre la vista de correos, **Then** ve conteos por estado, la antigüedad del pendiente más viejo y la lista de fallidos con tipo, fecha, intentos y motivo genérico, sin cuerpo, asunto, destinatario completo ni categoría.
2. **Given** un correo fallido de un tipo reintentable, **When** soporte lo reintenta con motivo, **Then** vuelve a la cola, se registra la acción y se envía en el siguiente ciclo.
3. **Given** un aviso de urgencia fallido, **When** soporte revisa la cola, **Then** solo ve que existe un aviso de urgencia fallido y que ya se encoló el aviso genérico; no hay forma de ver ni reencolar la categoría.
4. **Given** un micrositio publicado, **When** soporte cambia su nombre de enlace a uno libre y válido, **Then** el nuevo enlace funciona, el anterior deja de resolver y el cambio queda registrado; si el nombre ya existe o es inválido, se rechaza sin cambios.
5. **Given** la vista de micrositios, **When** soporte la abre, **Then** ve cuántos están publicados, despublicados o en borrador y puede filtrar por estado.

---

### User Story 3 - Soporte consulta las métricas del piloto (Priority: P2)

Soporte ve un tablero **agregado y sin datos personales** con las métricas con las que se decide si el piloto funciona: finalización de reserva (meta superior al 70 %), tiempo para reservar (meta inferior a 2 minutos), correos entregados (meta superior al 98 %), urgencias con espacio frente a «sin espacio», citas por médico por semana y médicos que usan la agenda por su cuenta cada semana (uso en la semana 4). Se puede elegir el periodo (última semana, últimas 4 semanas o todo el piloto) y se muestra, junto a cada métrica, la meta del piloto y si se cumple.

**Why this priority**: sin estas cifras no se puede aplicar el criterio de salida del piloto, pero la operación diaria no depende de ellas.

**Independent Test**: con datos de prueba conocidos (reservas completas e incompletas, correos enviados y fallidos, urgencias agendadas y sin espacio), comprobar que cada cifra coincide con el cálculo manual y que no hay nombres, correos ni categorías en la pantalla.

**Acceptance Scenarios**:

1. **Given** datos de un periodo, **When** soporte abre las métricas, **Then** ve cada cifra con su meta y su cumplimiento, y todas son conteos o porcentajes sin datos personales.
2. **Given** un periodo sin datos, **When** se abre el tablero, **Then** se muestra «sin datos» en cada métrica, no cero ni errores.
3. **Given** las urgencias, **When** se muestra la métrica, **Then** solo compara solicitudes agendadas con «sin espacio» (las señales de alarma y el CAPTCHA no disponible no se registran por diseño) y nunca desglosa por categoría.

---

### User Story 4 - Soporte consulta el registro de acciones y todo queda auditado (Priority: P3)

Soporte puede ver el **historial de acciones de soporte**: quién, qué acción, sobre qué cuenta o recurso, cuándo y con qué motivo, filtrable por persona, tipo y fecha. El registro es de solo lectura: nadie puede editarlo ni borrarlo desde el panel. Además, abrir cualquier detalle sensible del panel (por ejemplo el documento de la cédula de un médico) también deja registro.

**Why this priority**: da trazabilidad y permite reconstruir qué pasó ante una disputa, pero no bloquea la operación.

**Independent Test**: realizar varias acciones con dos cuentas de soporte distintas, abrir el historial y comprobar que aparecen todas con autor y motivo, que el filtro funciona y que no hay forma de modificarlo.

**Acceptance Scenarios**:

1. **Given** acciones previas de soporte, **When** se abre el historial, **Then** se listan de la más reciente a la más antigua con persona, acción, objetivo, fecha y motivo, con paginación.
2. **Given** el historial, **When** se filtra por persona, tipo o fechas, **Then** solo aparecen las coincidencias.
3. **Given** que soporte abre el documento de cédula de un médico, **When** lo hace, **Then** queda una entrada «consulta de cédula» con persona y fecha, sin contenido.
4. **Given** cualquier sesión de soporte, **When** intenta modificar o borrar una entrada del historial, **Then** no existe ninguna ruta ni botón que lo permita.

---

### User Story 5 - Soporte libera una cédula en disputa con las garantías debidas (Priority: P3)

Cuando una cédula está registrada por error o por otra persona, soporte la **libera** desde el detalle del médico, con motivo y confirmación. El médico afectado queda sin cédula y sin acceso a funciones hasta registrar otra y ser aprobado de nuevo, y se le avisa con un texto fijo; el motivo interno queda solo en el historial. Como esta acción deja a una cuenta ya aprobada sin acceso, el panel muestra antes de confirmar qué efecto tendrá: cuántas citas futuras tiene esa cuenta y si su micrositio está publicado.

**Why this priority**: resuelve el supuesto abierto 10 de las decisiones del proyecto. La acción ya existe; aquí se completa con la advertencia del efecto y con su registro en el historial.

**Independent Test**: liberar la cédula de un médico con citas futuras y micrositio publicado, comprobar la advertencia previa, que la cédula puede registrarla otra persona y que el médico queda sin acceso; comprobar que queda en el historial.

**Acceptance Scenarios**:

1. **Given** un médico con cédula, citas futuras y micrositio publicado, **When** soporte abre la confirmación de liberación, **Then** ve el número de citas futuras y el estado del micrositio antes de confirmar.
2. **Given** la confirmación con motivo, **When** se aplica, **Then** la cédula queda libre para otra cuenta, el médico pierde el acceso, su micrositio deja de aceptar reservas y se le avisa por correo con un texto fijo.
3. **Given** una cédula liberada, **When** otra persona se registra con ella, **Then** el registro procede normalmente.

---

### Edge Cases

- Dos personas de soporte cambian el estado de la misma cuenta a la vez: la segunda ve el estado ya cambiado y su acción se rechaza sin duplicarse; solo una transición se aplica.
- Un médico suspendido o en solo lectura que sigue con una sesión abierta: la sesión deja de ser válida o se limita en la siguiente petición, no al expirar.
- Un médico suspendido cuyos pacientes tienen citas futuras: las citas se conservan y se muestran como siempre al paciente; no se cancelan en bloque ni se envían avisos masivos; soporte ve cuántas citas futuras hay antes de suspender y decide con eso.
- Suspender o poner en solo lectura mientras entra una reserva o una urgencia: se respeta el estado definitivo; la reserva se rechaza o se completa antes del cambio, nunca queda a medias.
- Soporte intenta suspenderse, o cambiar el estado de otra cuenta de soporte: no se permite desde el panel (las cuentas de soporte las crea el equipo de la plataforma fuera del flujo público).
- Un correo fallido de un tipo que contiene datos sensibles (urgencia): no se ofrece reintento ni vista de contenido.
- La cola tiene miles de correos: los conteos son agregados y la lista de fallidos se pagina; el panel responde con fluidez.
- Un cambio de nombre de enlace a uno que ya tuvo otro micrositio: el nombre anterior queda reservado y no puede reutilizarse de inmediato, para no desviar tráfico viejo a otro consultorio.
- Falta de doble factor en la cuenta de soporte, o sesión caducada a media acción: se pide autenticarse otra vez y la acción no se aplica.
- Una persona sin rol de soporte (médico, recepción o paciente) intenta cualquier ruta o acción del panel: recibe acceso denegado y no se revela si el recurso existe.

## Requirements *(mandatory)*

### Functional Requirements

**Acceso y auditoría**

- **FR-001**: El panel MUST ser accesible solo al personal de soporte autenticado con doble factor ya verificado en la sesión; cualquier otro rol o una sesión sin segundo factor MUST recibir acceso denegado.
- **FR-002**: Toda acción de soporte que cambie un estado, y toda consulta de un dato sensible (documento de cédula), MUST registrar quién, qué, sobre qué objetivo, cuándo y el motivo cuando aplique, en un historial de solo lectura que ningún rol pueda editar ni borrar.
- **FR-003**: Toda acción que cambie un estado MUST exigir un motivo (texto obligatorio, longitud limitada) y una confirmación explícita antes de aplicarse; un envío sin ambos MUST NOT cambiar nada. Excepción vigente desde la feature 1: **aprobar** no pide motivo ni casilla y **rechazar** pide motivo pero no casilla (decisión pendiente del responsable: alinearlas con esta regla cambiaría el flujo ya probado).
- **FR-004**: Soporte MUST NOT poder iniciar sesión como un médico, recepción o paciente ni actuar en su nombre; no existe función de impersonación.
- **FR-005**: Las rutas del panel MUST validar toda entrada, estar protegidas contra envíos entre sitios y tener límite de peticiones; las acciones de cambio MUST ser idempotentes ante doble envío.

**Ciclo de vida de la cuenta del médico**

- **FR-006**: Soporte MUST poder ver la lista de médicos por estado (pendiente, aprobado, rechazado, suspendido, solo lectura) con búsqueda por nombre o correo, y el detalle de cada uno con su estado, fechas, estado del micrositio y número de citas futuras (solo el número).
- **FR-007**: Soporte MUST poder aprobar y rechazar solicitudes como hoy, y además suspender, poner en solo lectura y reactivar cuentas, cada una con motivo y confirmación, y con las transiciones válidas definidas: activo ↔ suspendido, activo ↔ solo lectura, solo lectura → suspendido. Cualquier otra transición MUST rechazarse.
- **FR-008**: Una cuenta suspendida MUST NOT poder iniciar sesión, sus sesiones abiertas MUST invalidarse y su micrositio MUST NOT aceptar reservas ni urgencias, mostrando que se confirme por teléfono con el consultorio.
- **FR-009**: Una cuenta en solo lectura MUST poder entrar y consultar, pero el servidor MUST rechazar toda acción que cree o modifique citas, bloqueos, configuración, franjas, publicación o invitaciones de recepción, y su micrositio MUST NOT aceptar reservas ni urgencias nuevas. Las citas ya agendadas MUST conservarse y los pacientes MUST poder cancelarlas.
- **FR-010**: Los cambios de estado MUST avisar por correo al médico con un texto fijo que no incluya el motivo interno, y MUST registrarse en el historial.
- **FR-011**: Durante el piloto la cuenta aprobada MUST permanecer activa hasta que soporte la cambie; el sistema MUST NOT pasar cuentas a solo lectura ni suspenderlas automáticamente por tiempo de prueba o por falta de pago.
- **FR-012**: Soporte MUST poder liberar una cédula como hoy; antes de confirmar el panel MUST mostrar el número de citas futuras y el estado del micrositio de esa cuenta, y tras liberar el micrositio MUST dejar de aceptar reservas.
- **FR-013**: Soporte MUST NOT poder cambiar el estado de otra cuenta de soporte ni el suyo desde el panel.

**Micrositios y correos**

- **FR-014**: Soporte MUST poder ver el estado de los micrositios (borrador, publicado, despublicado), filtrarlos y ver el nombre de enlace de cada uno.
- **FR-015**: Soporte MUST poder cambiar el nombre del enlace de un micrositio con las mismas reglas de formato y unicidad que aplican al crearlo, con motivo y confirmación; el enlace anterior MUST dejar de resolver y quedar reservado para su antiguo dueño durante 90 días, sin poder asignarse a otro médico en ese plazo, y el cambio MUST registrarse.
- **FR-016**: Soporte MUST ver el estado de la cola de correos de forma agregada: conteos por estado, antigüedad del pendiente más viejo y lista paginada de fallidos con tipo, fecha, número de intentos y un motivo técnico genérico.
- **FR-017**: La vista de correos MUST NOT mostrar cuerpo, asunto, destinatario completo, datos de pacientes ni la categoría de una urgencia, y MUST NOT existir forma de obtenerlos desde el panel.
- **FR-018**: Soporte MUST poder reintentar un correo fallido y cancelarlo, con motivo y confirmación, excepto los de tipos que contienen datos sensibles de urgencia, que MUST NOT reencolarse con su categoría.

**Métricas y registro**

- **FR-019**: El panel MUST mostrar las métricas del piloto agregadas y sin datos personales: finalización de reserva, tiempo para reservar, correos entregados, urgencias agendadas frente a «sin espacio», citas por médico por semana y médicos activos por semana, para el periodo elegido, con la meta y su cumplimiento.
- **FR-020**: Ninguna métrica ni registro del panel MUST contener nombres, correos, teléfonos, categoría de urgencia ni contenido de mensajes, ni aun desglosado por médico (por médico solo se muestran conteos).
- **FR-021**: Soporte MUST poder consultar el historial de acciones de soporte, paginado y filtrable por persona, tipo de acción y fechas.
- **FR-022**: Los datos de pacientes MUST quedar fuera del panel: soporte no ve nombres, correos, teléfonos, búsquedas de cuentas ni citas individuales de pacientes, y los reclamos de un paciente se resuelven con su médico. Decisión del responsable (2026-11-24); se revisa después del piloto.
- **FR-023**: Los datos de un médico suspendido o con cédula liberada MUST conservarse sin plazo de borrado automático; solo se borran a petición del titular, por el procedimiento de derechos del titular, y el plazo definitivo de conservación lo fija la revisión legal. Esta feature MUST NOT añadir borrado ni anonimización programados. Decisión del responsable (2026-11-24).

### Key Entities

- **Estado de la cuenta del médico**: situación operativa de la cuenta además de su aprobación: activo, suspendido o solo lectura, con quién lo cambió, cuándo y por qué; determina acceso, escritura y si su micrositio acepta reservas.
- **Acción de soporte**: entrada del historial de solo lectura con la persona de soporte, el tipo de acción, el objetivo (cuenta, micrositio o correo), la fecha y el motivo; incluye consultas de datos sensibles.
- **Nombre de enlace reservado**: nombre de micrositio que fue de un consultorio y no puede reasignarse de inmediato a otro.
- **Resumen de la cola de correos**: conteos por estado, antigüedad y lista de fallidos con tipo, fecha, intentos y motivo genérico; nunca contenido, destinatario completo ni categoría.
- **Métrica del piloto**: cifra agregada de un periodo con su meta y su cumplimiento, sin datos personales.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Soporte suspende, pone en solo lectura o reactiva una cuenta en menos de 2 minutos de trabajo efectivo desde que abre el detalle.
- **SC-002**: El 100 % de las acciones de soporte que cambian un estado queda en el historial con persona, motivo y fecha, y ninguna se aplica sin motivo y confirmación.
- **SC-003**: Un médico suspendido deja de poder entrar y de recibir reservas en menos de 1 minuto desde la confirmación.
- **SC-004**: En el 100 % de las pruebas, ninguna pantalla, respuesta ni registro del panel contiene categoría de urgencia, contenido de mensajes, ni datos personales de pacientes.
- **SC-005**: Soporte identifica un correo atorado o fallido y lo reintenta en menos de 3 minutos desde que abre el panel.
- **SC-006**: Las cifras de las métricas coinciden al 100 % con el cálculo manual sobre un conjunto de datos de prueba conocido.
- **SC-007**: Ningún usuario con rol distinto de soporte, ni soporte sin doble factor, puede abrir una pantalla ni ejecutar una acción del panel.
- **SC-008**: Con tres cuentas de médico y dos de soporte actuando a la vez sobre las mismas cuentas, cada cuenta termina en un solo estado válido y el historial refleja cada acción una sola vez.

## Assumptions

- **Alcance de la feature**: cubre el panel del piloto (3 a 5 médicos y una o dos personas de soporte). Quedan fuera WhatsApp, el cobro con Openpay, el historial clínico, la reprogramación, el registro abierto, la creación de cuentas de soporte desde la interfaz (las crea el equipo fuera del flujo público) y la validación automática de la cédula.
- **Solo lectura y suspensión manuales**: durante el piloto el estado solo lo cambia una persona de soporte. El paso automático a solo lectura por falta de pago llega con el cobro y no se implementa aquí; el estado y su efecto sobre reservas y escrituras sí se construyen ahora para que el cobro lo reutilice.
- **Reutilización**: se reutilizan el rol de soporte con doble factor, el historial de decisiones de soporte, la cola de correos con sus claves sensibles, el registro de acciones del calendario y las reglas de aceptación de reservas de las features 1 a 4; el panel no duplica esa lógica.
- **Reserva del enlace anterior**: 90 días (decisión de diseño aceptada para el piloto; ajustable sin cambiar el resto).
- **Motivos de las acciones**: son texto libre interno; el formulario advierte que no deben contener datos de pacientes y el historial solo lo ve soporte.
- **Términos**: en pantallas y correos se dice «solo lectura» y «suspendida»; en la base de datos y el código, `read_only` y `suspended`.
- **Citas de una cuenta suspendida**: se conservan y no se cancelan en bloque; avisar o reubicar a los pacientes lo decide el médico o soporte caso por caso fuera de esta feature.
- **Textos fijos al médico**: los correos de cambio de estado usan texto estándar y provisional hasta la revisión legal, y nunca incluyen el motivo interno.
- **Metas del piloto**: las de las decisiones del proyecto (finalización > 70 %, tiempo para reservar < 2 minutos, correos entregados > 98 %, uso en la semana 4); los criterios de «reserva completada» y «tiempo para reservar» se definieron en el plan: se cuenta la entrada a la pantalla de reservar (una vez por visita) y la reserva confirmada, y el tiempo corre entre ambas, con contadores diarios por médico que no identifican a nadie.
- **Entorno**: hosting compartido con cron por minuto; las métricas se calculan al abrir el tablero sobre datos ya guardados, sin procesos permanentes ni servicios externos.
- **Datos de pacientes**: el panel no muestra ninguno (FR-022); puede ampliarse después del piloto con una decisión nueva.
- **Dependencias**: la feature 4 debe estar cerrada (T050 a T053) porque esta feature lee la cola de correos y el estado de las urgencias.
