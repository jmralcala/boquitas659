# Feature Specification: Micrositio del médico y reserva del paciente

**Feature Branch**: `003-micrositio-y-reserva-del-paciente` (sin rama dedicada; se trabaja en `main`)

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description: "Feature 3: Micrositio del médico y reserva del paciente. Cada médico aprobado publica su calendario en un micrositio público (`/c/nombre`, sin directorio, `noindex`) con ubicación (dirección y enlace «Cómo llegar»), teléfono del consultorio y logo opcional. El paciente elige «Primera cita» o «Ya soy paciente», inicia sesión o crea su cuenta, elige día y horario en un calendario sin fechas pasadas y reserva (también para sus pacientes adicionales). El servidor comprueba las anticipaciones del médico y la no doble reserva. La cita queda agendada sin confirmación; el paciente recibe un correo con enlace para ver o cancelar y un recordatorio antes del límite de cancelación; puede cancelar hasta 24 h antes (configurable) y el médico recibe aviso. Abrir un enlace de correo nunca cambia el estado."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El médico publica su micrositio (Priority: P1)

Un médico aprobado abre «Mi micrositio» y elige el nombre de su enlace (por ejemplo `clinica-sonrisa`), captura la dirección del consultorio, sube un logo opcional y define con cuánta anticipación puede cancelar un paciente (24 horas por defecto). Cuando todo está completo, publica su calendario y obtiene el enlace público para compartirlo. Puede despublicarlo cuando quiera.

**Why this priority**: Sin micrositio publicado no hay por dónde reserve un paciente: es la puerta de entrada de toda la feature.

**Independent Test**: Con un médico aprobado con horario configurado, elegir un nombre, capturar la dirección, publicar, abrir el enlace sin sesión y comprobar que se ve el consultorio; despublicar y comprobar que el enlace deja de aceptar reservas.

**Acceptance Scenarios**:

1. **Given** un médico aprobado con horario de atención y teléfono del consultorio, **When** elige un nombre libre válido, captura su dirección y publica, **Then** su micrositio queda accesible en `/c/<nombre>` y el médico ve el enlace para copiarlo.
2. **Given** un nombre ya usado por otro médico, **When** intenta registrarlo, **Then** se rechaza con un mensaje claro y no se reserva nada; cuando dos médicos intentan el mismo nombre a la vez, solo uno lo obtiene.
3. **Given** un nombre con mayúsculas, espacios, acentos, guiones al principio o al final o menos de 3 caracteres, **When** intenta guardarlo, **Then** se rechaza indicando las reglas (solo minúsculas, números y guiones).
4. **Given** un nombre ya elegido, **When** el médico quiere cambiarlo, **Then** no puede hacerlo por sí mismo: la pantalla indica que el cambio lo hace soporte.
5. **Given** un médico sin horario de atención configurado, o sin dirección, **When** intenta publicar, **Then** se rechaza indicando qué falta.
6. **Given** un logo que no es una imagen válida (otro tipo de archivo, demasiado pesado), **When** lo sube, **Then** se rechaza sin guardarlo.
7. **Given** una persona de recepción, **When** intenta publicar, despublicar o cambiar el nombre, la dirección o el logo, **Then** el sistema lo niega: solo el médico administra su micrositio.
8. **Given** un médico pendiente, rechazado o suspendido, **When** intenta publicar, **Then** el sistema lo niega.

---

### User Story 2 - El paciente abre el micrositio y entra a su cuenta (Priority: P1)

Una persona abre el enlace del consultorio sin haber iniciado sesión y ve el nombre del médico, su ubicación con un enlace «Cómo llegar», su teléfono, el logo si lo hay y dos opciones: «Primera cita» y «Ya soy paciente». Con «Ya soy paciente» escribe su correo y su contraseña. Con «Primera cita» (o si el correo que escribió no tiene cuenta) crea su cuenta de paciente con sus datos y una contraseña, aceptando el aviso de privacidad.

**Why this priority**: Reservar exige una cuenta de paciente; esta puerta de entrada es lo que evita pedirle registro a quien solo quiere ver el consultorio.

**Independent Test**: Sin sesión, abrir el micrositio, comprobar que no se ve ningún horario ni dato de otros pacientes, entrar con una cuenta existente y con una nueva, y llegar en ambos casos al calendario.

**Acceptance Scenarios**:

1. **Given** un micrositio publicado, **When** una persona sin sesión lo abre, **Then** ve nombre, dirección con enlace «Cómo llegar», teléfono del consultorio, logo (si existe), las dos opciones y, en el pie, el aviso de privacidad; no ve horarios ni datos de pacientes.
2. **Given** un correo con cuenta de paciente, **When** elige «Ya soy paciente» y escribe la contraseña correcta, **Then** inicia sesión y pasa al calendario del consultorio.
3. **Given** un correo sin cuenta, **When** elige «Ya soy paciente», **Then** el sistema le indica que no encontró esa cuenta y le ofrece «Primera cita».
4. **Given** una contraseña incorrecta, **When** intenta entrar, **Then** recibe el mismo mensaje de error y la espera creciente de la feature 1, y puede recuperar su contraseña por correo.
5. **Given** «Primera cita», **When** completa nombre, fecha de nacimiento, correo, teléfono y contraseña y marca la casilla de aceptación del aviso de privacidad (sin marcar de antemano), **Then** se crea su cuenta, queda con sesión iniciada y pasa al calendario; sin la casilla marcada no puede continuar.
6. **Given** un correo que pertenece a un médico, a recepción o a soporte, **When** se usa en «Ya soy paciente» o en «Primera cita», **Then** el sistema responde como si no existiera una cuenta de paciente con ese correo, sin revelar el rol.
7. **Given** una misma dirección de IP que prueba muchos correos, **When** supera el límite, **Then** recibe un rechazo con espera y no puede seguir probando.
8. **Given** una persona que ya inició sesión, **When** abre el micrositio, **Then** pasa directo al calendario.

---

### User Story 3 - El paciente reserva una cita (Priority: P1)

Con sesión iniciada, el paciente ve un calendario que no permite fechas pasadas. Al elegir un día aparecen los horarios disponibles; elige uno, elige para quién es la cita (él mismo o uno de sus pacientes adicionales, por ejemplo un hijo), confirma que comparte sus datos de contacto con ese consultorio y pulsa «Reservar». La cita queda agendada en ese momento, sin confirmación posterior, y la pantalla le muestra el resumen.

**Why this priority**: Es el valor central de la feature y de todo el producto: que el paciente reserve sin intermediarios, sin que se produzca una doble reserva.

**Independent Test**: Reservar un horario libre y comprobar que queda ocupado en la agenda del médico; lanzar muchas reservas simultáneas del mismo horario y comprobar que solo una prospera; intentar reservar fuera de la anticipación permitida.

**Acceptance Scenarios**:

1. **Given** un micrositio publicado y un paciente con sesión, **When** abre el calendario, **Then** no puede elegir fechas pasadas ni posteriores a la anticipación máxima del médico, y al elegir un día ve solo los horarios libres que cumplen la anticipación mínima.
2. **Given** un horario libre, **When** el paciente reserva, **Then** la cita queda agendada de inmediato, aparece en la agenda del médico y de su recepción como cita del paciente, y el horario deja de ofrecerse a otros.
3. **Given** varios pacientes que reservan el mismo horario a la vez, **When** las peticiones llegan simultáneas, **Then** exactamente una cita se crea y los demás ven un mensaje amable («Ese horario ya no está disponible») con los horarios actualizados.
4. **Given** un horario que cambió de estado entre que el paciente lo vio y lo reservó (ocupado, bloqueado, fuera de la anticipación, calendario despublicado), **When** reserva, **Then** el servidor lo rechaza aunque el navegador lo hubiera ofrecido.
5. **Given** un paciente con pacientes adicionales, **When** elige para quién es la cita, **Then** puede escoger al titular o a cualquiera de sus pacientes adicionales, y la cita queda a nombre de la persona elegida; nunca puede elegir a un paciente de otra cuenta.
6. **Given** un paciente sin pacientes adicionales que quiere reservar para un hijo, **When** elige «Añadir un paciente», **Then** puede registrarlo (flujo de la feature 1) y continuar.
7. **Given** la primera vez que reserva con ese consultorio, **When** llega al botón «Reservar», **Then** ve qué datos verá el consultorio (nombre, fecha de nacimiento, teléfono y correo) y debe marcar una casilla, sin marcar de antemano, que autoriza compartirlos; la autorización queda registrada con quién, con qué consultorio y cuándo.
8. **Given** un paciente que ya tiene el máximo de citas vigentes con ese consultorio, o que supera el límite de reservas por hora, **When** intenta reservar, **Then** recibe un mensaje claro y la espera que corresponda.
9. **Given** un micrositio despublicado, de un médico no aprobado o suspendido, **When** alguien intenta reservar (aunque tenga una pantalla abierta de antes), **Then** el servidor lo rechaza y se muestra que debe confirmar directamente con el consultorio por teléfono.
10. **Given** una sesión que caduca a mitad de la reserva, **When** el paciente vuelve a iniciar sesión, **Then** regresa al mismo consultorio y al mismo día que estaba viendo, y puede elegir de nuevo el horario.

---

### User Story 4 - El paciente y el médico reciben sus correos (Priority: P1)

Al reservar, el paciente recibe un correo informativo con la fecha, la hora, el consultorio, la ubicación y un enlace para ver o cancelar la cita. El médico recibe un aviso de cita nueva. Abrir el enlace de un correo nunca cambia nada: muestra el resumen y un botón.

**Why this priority**: Sin correo, el paciente no tiene constancia ni forma de cancelar, y el médico no se entera de las reservas que entran fuera de horario de consultorio.

**Independent Test**: Reservar y comprobar los dos correos (contenido, remitente y respuesta al médico); abrir el enlace varias veces, incluso con un cliente automático, y comprobar que la cita no cambia.

**Acceptance Scenarios**:

1. **Given** una reserva exitosa, **When** se procesa la cola de correos, **Then** el paciente (o el tutor, si la cita es de un menor) recibe «Tu cita dental fue agendada» con fecha, hora en la zona del consultorio, nombre del consultorio, dirección y teléfono, un enlace para ver o cancelar, y al responder el correo la respuesta va al médico.
2. **Given** la misma reserva, **When** se procesa la cola, **Then** el médico recibe un aviso de cita nueva con el nombre del paciente, la fecha, la hora y la etiqueta «convencional», sin otros datos de contacto.
3. **Given** el enlace del correo, **When** se abre (varias veces o por un programa antivirus), **Then** muestra el resumen de la cita y un botón, y no cambia el estado de la cita.
4. **Given** un enlace vencido, ya usado, de una cita ya cancelada o manipulado, **When** se abre, **Then** se rechaza con un mensaje genérico sin revelar datos.
5. **Given** que el correo no se puede entregar tras los reintentos, **When** se agota, **Then** la cita se conserva y el paciente la sigue viendo en «Mis citas».
6. **Given** que la cita se cancela antes de que salga el correo de «agendada», **When** se procesa la cola, **Then** ese correo no se envía.

---

### User Story 5 - El paciente ve y cancela sus citas (Priority: P2)

El paciente abre «Mis citas» y ve las próximas y las recientes, las suyas y las de sus pacientes adicionales. Puede cancelar una cita hasta el límite de cancelación del consultorio (24 horas antes por defecto), desde la pantalla o desde el enlace del correo, con sesión iniciada. Pasado el límite, la pantalla le indica que debe llamar al consultorio. El médico recibe un aviso de la cancelación y el horario queda libre.

**Why this priority**: Evita citas perdidas y libera horarios, pero la reserva funciona sin ello.

**Independent Test**: Cancelar una cita lejana y comprobar que el horario queda libre y que el médico recibe el aviso; intentar cancelar dentro del límite y comprobar que se rechaza; cancelar desde el enlace del correo sin sesión y comprobar que antes pide iniciar sesión.

**Acceptance Scenarios**:

1. **Given** una cita con más anticipación que el límite del consultorio, **When** el paciente la cancela, **Then** queda cancelada, el horario se libera de inmediato, el médico recibe el aviso con el nombre del paciente, la fecha y la hora, y el paciente recibe la constancia por correo.
2. **Given** una cita dentro del límite de cancelación, **When** el paciente intenta cancelarla, **Then** se rechaza indicando el teléfono del consultorio para hacerlo por esa vía.
3. **Given** el enlace de un correo, **When** el paciente lo abre sin sesión, **Then** se le pide iniciar sesión y, al hacerlo, vuelve al resumen de esa cita con el botón de cancelar; abrir el enlace nunca cancela.
4. **Given** una sesión de otra cuenta, **When** abre el enlace de la cita de un paciente distinto, **Then** no ve el resumen ni puede cancelar (respuesta genérica).
5. **Given** una cita ya cancelada o ya pasada, **When** se intenta cancelar de nuevo, **Then** se rechaza sin repetir avisos.
6. **Given** cancelaciones simultáneas de la misma cita, **When** llegan a la vez, **Then** una prospera y las demás reciben conflicto, y se envía un solo aviso.
7. **Given** un paciente que cancela muchas citas en poco tiempo, **When** supera el límite, **Then** recibe un rechazo con espera.
8. **Given** una cita que el médico o su recepción cancelan (feature 2), **When** ocurre, **Then** el paciente la ve cancelada en «Mis citas» y recibe el aviso ya existente.

---

### User Story 6 - El paciente recibe un recordatorio (Priority: P2)

Unas 30 horas antes de la cita (6 horas antes del límite de cancelación del consultorio), el paciente recibe un correo de recordatorio con un enlace para ver o cancelar la cita mientras todavía puede hacerlo.

**Why this priority**: Reduce las ausencias y deja una última oportunidad para cancelar a tiempo, pero no bloquea la reserva.

**Independent Test**: Con citas a distintas distancias, ejecutar la tarea programada en distintos momentos y comprobar quién recibe recordatorio, cuándo y cuántas veces.

**Acceptance Scenarios**:

1. **Given** una cita vigente que está a 30 horas o menos de empezar y aún sin recordatorio, **When** corre la tarea programada, **Then** se envía un solo recordatorio, y repetir la tarea o reintentar el correo no genera otro.
2. **Given** una cita que se reservó con menos anticipación que el momento del recordatorio, **When** pasa ese momento, **Then** no se envía recordatorio (basta la confirmación).
3. **Given** una cita cancelada antes del recordatorio, **When** corre la tarea, **Then** no se envía.
4. **Given** un consultorio que cambió su límite de cancelación, **When** se calculan los recordatorios futuros, **Then** el recordatorio sale 6 horas antes del nuevo límite.
5. **Given** una cita creada por el médico o su recepción (feature 2), **When** corre la tarea, **Then** también recibe recordatorio.

---

### User Story 7 - El paciente ve y revoca los consultorios con los que está vinculado (Priority: P2)

El paciente abre «Mis consultorios» y ve con qué consultorios tiene relación, quién la creó (él al reservar, o el personal del consultorio al agendarle una cita) y desde cuándo. Si un consultorio lo vinculó sin que él lo hubiera pedido, recibe un aviso por correo. Puede revocar un vínculo: el consultorio deja de poder ver sus datos de contacto.

**Why this priority**: Es la salvaguarda de privacidad que faltaba en la feature 2, donde el personal puede vincular a una cuenta a partir de su correo exacto.

**Independent Test**: Con un vínculo creado por el personal, comprobar el aviso por correo, que el paciente lo ve, y que al revocarlo el médico ya no accede al detalle del paciente.

**Acceptance Scenarios**:

1. **Given** un vínculo creado al reservar el propio paciente, **When** abre «Mis consultorios», **Then** lo ve marcado como «Lo creaste tú» con fecha.
2. **Given** un vínculo creado por el personal de un consultorio, **When** ocurre, **Then** el titular de la cuenta recibe un correo con el consultorio, la fecha y cómo revocarlo, y lo ve en «Mis consultorios» marcado como «Lo creó el consultorio».
3. **Given** un vínculo vigente, **When** el paciente lo revoca (tras una pantalla que explica las consecuencias y pide confirmar), **Then** sus citas futuras con ese consultorio se cancelan, el médico recibe el aviso de cada una, los horarios quedan libres y el consultorio deja de ver sus datos de contacto; el consultorio conserva solo el registro de las citas pasadas con el nombre del paciente.
4. **Given** un vínculo revocado, **When** el personal intenta consultar el detalle de ese paciente, **Then** responde como si no existiera.
5. **Given** un paciente que revocó un vínculo, **When** vuelve a reservar con ese consultorio, **Then** se vuelve a crear el vínculo con una nueva autorización.

---

### Edge Cases

- **Nombre del enlace**: dos médicos intentan registrar el mismo a la vez (solo uno lo obtiene); el nombre solo admite minúsculas sin acentos, números y guiones, de 3 a 40 caracteres, sin guiones al principio, al final ni dobles; un nombre reservado por un médico que luego deja de estar aprobado sigue siendo suyo.
- **Enlace de un médico que nunca publicó**: responde como si no existiera (no revela que el nombre está tomado); uno que ya publicó y se despublicó, o cuyo médico ya no está aprobado, muestra solo un aviso con el nombre del consultorio y su teléfono, sin calendario ni reserva.
- **Dirección sin capturar**: el micrositio no muestra el enlace «Cómo llegar» y sigue funcionando con los demás datos.
- **Calendario sin horarios libres** en la ventana permitida: se indica «No hay horarios disponibles» y el teléfono del consultorio.
- **Zona horaria con cambio de hora** (frontera): los horarios se muestran en la hora del consultorio y la comprobación de anticipación usa instantes, no horas locales.
- **Correo del paciente cambiado o cuenta desactivada** después de reservar: la cita se conserva; los avisos ya encolados conservan el destinatario con que se encolaron y los que se encolan después (por ejemplo el recordatorio) usan el correo vigente de la cuenta.
- **Menor sin tutor** o paciente adicional de otra cuenta: no se puede reservar.
- **Doble envío del formulario** o recarga: no crea dos citas ni dos correos: si la cita vigente de ese horario ya es de la misma cuenta, la segunda petición lleva a esa cita en lugar de dar error.
- **El médico reduce la anticipación máxima o cambia la duración** con citas ya reservadas: las citas se conservan (regla de la feature 2).
- **El médico deja de estar aprobado** con citas futuras: se conservan; el paciente puede cancelarlas desde su cuenta y se le indica el teléfono del consultorio.
- **Rastreo del micrositio**: los buscadores no deben indexarlo y no existe un listado de consultorios.
- **Imagen del logo con contenido malicioso** (archivo disfrazado): se rechaza por su contenido real, no por su extensión.
- **Enlace de correo abierto por un programa automático**: no cambia el estado; solo el botón, con sesión iniciada y protección contra peticiones falsificadas, cancela.

## Requirements *(mandatory)*

### Functional Requirements

**Micrositio y publicación (médico)**

- **FR-001**: Un médico aprobado MUST poder elegir el nombre de su enlace, una sola vez, con 3 a 40 caracteres formados solo por minúsculas sin acentos, números y guiones (sin guiones al principio, al final ni consecutivos). El nombre MUST ser único: el primero que lo registra se queda con él, aun con peticiones simultáneas.
- **FR-002**: El nombre del enlace MUST NOT poder regenerarse ni cambiarse por el médico; el cambio lo hace soporte. Un enlace antiguo deja de funcionar al cambiarse.
- **FR-003**: El médico MUST poder capturar la dirección del consultorio (texto) y subir un logo opcional. El logo MUST validarse por su contenido real (imagen PNG, JPEG o WebP) y por su tamaño máximo de 1 MB; si no es válido, MUST rechazarse sin guardarse.
- **FR-004**: El médico MUST poder definir con cuántas horas de anticipación puede cancelar un paciente (por defecto 24; de 0 a 168), dentro de la configuración de su calendario. El cambio afecta solo a cancelaciones futuras.
- **FR-005**: El médico MUST poder publicar y despublicar su micrositio. Para publicar, MUST tener nombre de enlace, dirección, teléfono del consultorio y al menos una franja en su horario de atención; si falta algo, se rechaza indicando qué.
- **FR-006**: Solo el médico aprobado MUST poder administrar su micrositio; la recepción, un médico pendiente, rechazado o suspendido, y los pacientes MUST recibir un 403.

**Acceso público al micrositio**

- **FR-007**: El micrositio MUST ser accesible sin sesión en `/c/<nombre>` solo mientras el calendario esté publicado y el médico esté aprobado. Mostrará nombre del médico, dirección con un enlace «Cómo llegar», teléfono del consultorio, logo (si existe), las opciones de reserva y, en el pie, el aviso de privacidad.
- **FR-008**: Un nombre de enlace que nunca se publicó MUST responder 404 como cualquier ruta inexistente. Uno que ya se publicó y luego se despublicó (o cuyo médico dejó de estar aprobado) MUST mostrar solo un aviso con el nombre del consultorio y su teléfono, sin calendario ni reserva.
- **FR-009**: El micrositio MUST NOT ser indexable por buscadores, MUST NOT existir un listado ni búsqueda de consultorios, y MUST tener límite de peticiones por dirección IP.
- **FR-010**: Cuando el médico capturó su dirección, el micrositio MUST mostrarla en texto y ofrecer un enlace «Cómo llegar» que la abra en un servicio de mapas en una pestaña nueva. La página MUST NOT incrustar contenido de terceros ni depender de claves, cuotas o topes de gasto de un proveedor de mapas (decisión del responsable, 2026-11-25: sustituye al mapa incrustado).

**Entrada del paciente**

- **FR-011**: El micrositio MUST ofrecer «Primera cita» y «Ya soy paciente». «Ya soy paciente» MUST pedir correo y contraseña con las reglas de la feature 1 (espera creciente, recuperación por correo, aviso por dispositivo nuevo). Si el correo no tiene cuenta de paciente, MUST ofrecer «Primera cita».
- **FR-012**: «Primera cita» MUST crear una cuenta de paciente con nombre, fecha de nacimiento, correo, teléfono y contraseña, y exigir la aceptación del aviso de privacidad vigente con una casilla sin marcar de antemano, registrada con quién, documento, versión y fecha (feature 1).
- **FR-013**: Un correo de un médico, de recepción o de soporte MUST tratarse como si no existiera una cuenta de paciente con él. Se acepta que el flujo revele si existe una cuenta de paciente; MUST mitigarse con un límite de intentos por IP y por correo.
- **FR-014**: Una persona con sesión de paciente que abre el micrositio MUST pasar directo al calendario; una sesión de médico, recepción o soporte MUST ver el micrositio sin poder reservar.

**Reserva**

- **FR-015**: El calendario MUST NOT permitir elegir fechas pasadas ni posteriores a la anticipación máxima del médico, y al elegir un día MUST mostrar solo los horarios libres que cumplen la anticipación mínima, calculados con la configuración, los bloqueos y las citas del médico.
- **FR-016**: El servidor MUST comprobar en CADA reserva del paciente que el horario existe en la configuración vigente, cumple la anticipación mínima y máxima del médico, está libre (sin cita ni bloqueo que se solape) y que el micrositio sigue publicado; el paciente MUST NOT poder saltarse estas reglas manipulando la petición.
- **FR-017**: La reserva MUST ser atómica con respecto a las demás operaciones de la agenda del médico: nunca existen dos citas vigentes en el mismo horario ni una cita dentro de un bloqueo, aun con reservas, cancelaciones y bloqueos simultáneos.
- **FR-018**: La cita MUST quedar agendada al reservar, sin confirmación posterior del paciente, y MUST registrar que la creó el paciente.
- **FR-019**: El paciente MUST poder reservar para sí o para cualquiera de sus pacientes adicionales (menores bajo su tutela, feature 1), y MUST NOT poder reservar para pacientes de otra cuenta. Podrá añadir un paciente adicional desde la reserva.
- **FR-020**: Antes de la primera reserva con un consultorio, la pantalla MUST indicar qué datos verá el consultorio (nombre, fecha de nacimiento, teléfono y correo) y exigir una casilla, sin marcar de antemano, que autoriza compartirlos. La autorización MUST registrarse con quién, para qué consultorio, cuándo y, si es un menor, que la dio el tutor. La reserva crea o reutiliza la relación médico-paciente.
- **FR-021**: Cada paciente MUST tener como máximo 3 citas vigentes con el mismo consultorio; cada **cuenta** MUST tener como máximo 5 reservas por hora (con cualquier consultorio y para cualquiera de sus pacientes); y MUST aplicarse un límite de reservas por IP. Al superarlos se responde con un mensaje claro y la espera.
- **FR-022**: Si el horario ya no está disponible al reservar, MUST informarse sin error técnico y mostrar los horarios actualizados del día.

**Correos**

- **FR-023**: Al reservar, el sistema MUST encolar, en la misma transacción que la cita, el correo de confirmación al paciente (al tutor si la cita es de un menor) con fecha y hora en la zona del consultorio, nombre del consultorio, dirección, teléfono y un enlace para ver o cancelar la cita, y el aviso de cita nueva al médico con el nombre del paciente, la fecha, la hora y la etiqueta «convencional».
- **FR-024**: Los correos del consultorio al paciente MUST llevar al médico como destinatario de las respuestas. El asunto MUST NOT contener datos personales y los correos MUST NOT contener datos clínicos.
- **FR-025**: Los enlaces de los correos MUST llevar un token firmado, de un solo uso, con caducidad y ligado a la cita; el enlace deja de servir cuando la cita se cancela o llega su hora (se valida al usarlo). Abrirlos MUST NOT cambiar el estado: muestran el resumen y un botón; el cambio ocurre al pulsarlo, con sesión iniciada de la cuenta dueña de la cita y protección contra peticiones falsificadas. El token se consume al cancelar.
- **FR-026**: Un enlace vencido, usado, manipulado o de una cita cancelada MUST responder con un mensaje genérico; el enlace abierto por otra cuenta MUST NOT revelar datos de la cita.

**Cancelación y «Mis citas»**

- **FR-027**: El paciente MUST ver en «Mis citas» las próximas citas y las de los últimos 90 días (propias y de sus pacientes adicionales, con cualquier consultorio), con su estado.
- **FR-028**: El paciente MUST poder cancelar una cita vigente hasta el límite de cancelación del consultorio; dentro del límite MUST rechazarse indicando el teléfono del consultorio. No existe reprogramación.
- **FR-029**: Al cancelar el paciente, el horario MUST liberarse de inmediato; el médico MUST recibir el aviso (nombre del paciente, fecha y hora) y el paciente la constancia por correo. Cancelar dos veces, o una cita pasada, MUST rechazarse sin repetir avisos, y las cancelaciones simultáneas MUST resolverse con un solo efecto.
- **FR-030**: Cancelar MUST estar limitado por **cuenta** (10 cancelaciones por hora, de cualquiera de sus pacientes) y por IP.

**Recordatorio**

- **FR-031**: El sistema MUST enviar un único recordatorio a cada cita vigente 6 horas antes del límite de cancelación del consultorio (30 horas antes con el límite por defecto), con un enlace para ver o cancelar. MUST ser idempotente ante reintentos y solapes de la tarea programada, y MUST NOT enviarse a citas canceladas ni a citas reservadas con menos anticipación que ese momento. Aplica también a las citas creadas por el personal.

**Vínculos del paciente**

- **FR-032**: El paciente MUST poder ver en «Mis consultorios» los consultorios vinculados con él y quién creó cada vínculo (él o el consultorio), y MUST recibir un correo cuando un consultorio lo vincule al agendarle una cita.
- **FR-033**: El paciente MUST poder revocar un vínculo, previa confirmación que explique las consecuencias. Al revocar, en una sola operación: se cancelan las citas futuras de ese paciente (y de sus pacientes adicionales vinculados) con ese consultorio, el médico recibe un aviso por cada una y los horarios se liberan; el consultorio MUST NOT poder ver el detalle de contacto del paciente, y conserva solo el registro de las citas pasadas con el nombre. El consultorio no puede deshacer la revocación; el paciente puede volver a reservar y se crea un vínculo nuevo con una nueva autorización.

**Seguridad, aislamiento y registro**

- **FR-034**: Toda entrada MUST validarse en el servidor y toda operación que cambia estado MUST estar protegida contra peticiones falsificadas; el médico de cada operación MUST salir del micrositio resuelto en el servidor, nunca de datos que mande el cliente.
- **FR-035**: Un paciente MUST ver solo sus citas y las de sus pacientes adicionales; el micrositio MUST NOT exponer datos de otros pacientes ni de la agenda más que horarios libres.
- **FR-036**: Cada reserva, cancelación, autorización y revocación MUST registrar quién y cuándo; los registros técnicos MUST NOT contener nombres, correos ni teléfonos.

### Key Entities

- **Micrositio**: página pública de un médico con su nombre de enlace único, dirección, logo opcional, estado (nunca publicado, publicado, despublicado) y el límite de cancelación.
- **Autorización de datos al consultorio**: constancia de que el paciente (o su tutor) acepta compartir sus datos de contacto con un consultorio, con fecha, quién y el vínculo.
- **Cita**: la de la feature 2, ahora también creada por el paciente, con su recordatorio enviado o no.
- **Enlace de cita**: token firmado, de un solo uso y con caducidad, ligado a una cita, que lleva al resumen para ver o cancelar.
- **Vínculo médico-paciente**: el de la feature 1, con origen (paciente o consultorio), fecha y posibilidad de revocarse.
- **Paciente y paciente adicional**: los de la feature 1.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un paciente nuevo, desde que abre el micrositio hasta tener su cita agendada, tarda menos de 3 minutos; uno con cuenta, menos de 2.
- **SC-002**: Al menos el 70 % de las personas que llegan al calendario terminan una reserva (métrica del piloto).
- **SC-003**: En las pruebas de concurrencia (al menos 20 reservas simultáneas del mismo horario, y reservas contra bloqueos y cancelaciones), exactamente una cita se crea y 0 horarios terminan con dos citas vigentes o con una cita dentro de un bloqueo.
- **SC-004**: El 100 % de los intentos de reservar fuera de la anticipación del médico, sobre horarios no libres o con el micrositio despublicado, se rechazan en el servidor aunque se manipule la petición.
- **SC-005**: Al menos el 98 % de los correos de confirmación y recordatorio se entregan dentro de los 5 minutos siguientes al evento (con el SMTP funcionando).
- **SC-006**: Cada cita vigente recibe como máximo un recordatorio, y el 100 % de los recordatorios que corresponden salen dentro de los 10 minutos posteriores a su hora.
- **SC-007**: En las pruebas, abrir cualquier enlace de correo 100 veces (incluido con un cliente automático) no cambia el estado de ninguna cita.
- **SC-008**: El micrositio y el calendario se muestran en menos de 2 segundos para un paciente con conexión normal, sin depender de ningún servicio externo.
- **SC-009**: 0 casos en que un paciente vea o cancele citas de otra cuenta, o en que se exponga a otros pacientes desde el micrositio.
- **SC-010**: El 100 % de las reservas, cancelaciones, autorizaciones y revocaciones quedan registradas con quién y cuándo.

## Assumptions

- **Alcance**: esta feature cubre el micrositio, la entrada del paciente, la reserva convencional, los correos de confirmación, recordatorio y aviso al médico, «Mis citas», la cancelación por el paciente y «Mis consultorios». Quedan fuera las urgencias y el triaje (feature 4), el panel de soporte completo (el cambio de nombre del enlace lo hace soporte con una herramienta mínima o un procedimiento manual; desde la feature 5 se hace en el panel, y el nombre anterior queda reservado 90 días), WhatsApp, el cobro con Openpay (el modo «solo lectura» por falta de pago llega con el cobro (desde la feature 5 soporte puede poner una cuenta en solo lectura o suspendida a mano, y el micrositio no acepta reservas en esos estados); aquí solo se respeta que un médico no aprobado o despublicado no recibe reservas), la reprogramación y el historial clínico.
- **Reglas del enlace**: de 3 a 40 caracteres; el nombre queda reservado para el médico aunque deje de estar aprobado; no hay lista de nombres prohibidos (el prefijo `/c/` evita choques con las rutas de la aplicación).
- **Logo y dirección**: logo PNG, JPEG o WebP de hasta 1 MB, guardado fuera de la raíz pública y entregado con cabeceras seguras; la dirección es texto libre de hasta 300 caracteres y el enlace «Cómo llegar» se construye a partir de esa dirección.
- **Límites contra el abuso** (ajustables, a revisar con datos del piloto): consulta de correo en «Ya soy paciente» y «Primera cita», 10 por minuto por IP; reservas, 5 por hora por cuenta y 20 por hora por IP; cancelaciones, 10 por hora por cuenta; máximo de citas vigentes por paciente con un mismo consultorio, 3.
- **Recordatorio**: sale 6 horas antes del límite de cancelación (30 h con el límite de 24 h), de modo que siempre llega mientras el paciente todavía puede cancelar; se calcula con la configuración vigente al momento de enviarlo.
- **Aviso al médico**: se envía al correo de la cuenta del médico (no a la recepción) e incluye solo el nombre del paciente, la fecha, la hora y la etiqueta «convencional».
- **Remitente de los correos**: salen de la plataforma (SPF, DKIM y DMARC) con el médico como destinatario de las respuestas; no se usa un SMTP propio del médico.
- **Consentimiento**: el aviso de privacidad se acepta al crear la cuenta (feature 1); la autorización de compartir datos con un consultorio es adicional y por consultorio. El paciente que ya tiene vínculo por una cita creada por el personal debe aceptar esa autorización la primera vez que reserve por sí mismo.
- **Revocación de un vínculo**: la revocación equivale a «ya no soy paciente de este consultorio» (decisión del 2026-11-23). El vínculo creado por el personal en la feature 2 sigue siendo inmediato; el paciente se entera por correo y puede revocarlo. Un vínculo «pendiente de confirmar» antes de agendar queda fuera de esta feature y se puede evaluar después del piloto.
- **Cuentas**: se reutilizan las de la feature 1 sin cambios; un correo de otro rol se trata como inexistente para el paciente.
- **Sesión**: la del paciente caduca a los 60 minutos de inactividad (feature 1); al volver a iniciar sesión se regresa al consultorio.
- **Zona horaria**: la del consultorio (feature 2); el paciente ve las horas en esa zona, indicándolo.
- **Métricas de uso**: SC-001 (tiempo para reservar), SC-002 (finalización) y SC-005 (entrega de correos en 5 minutos) se miden en el piloto con usuarios reales; no se prueban de forma automática.
- **Dependencias**: feature 1 (cuentas, menores, consentimientos, correo y recuperación), feature 2 (configuración, horarios libres, anticipaciones, no doble reserva, cancelación del consultorio) y el outbox por cron.
- **Constitución**: sujeta a los principios I (privacidad y consentimiento), II (aislamiento por médico), III (integridad y enlaces que no cambian estado) y IV (validación en servidor y límites de tasa).
