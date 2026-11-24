# Feature Specification: Urgencias y triaje

**Feature Branch**: `004-urgencias-y-triaje` (sin rama dedicada; se trabaja en `main`)

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description: "Feature 4: Urgencias y triaje. Un paciente con cuenta puede pedir una cita de urgencia desde el micrositio del médico. El triaje tiene 5 opciones con semáforo; el servidor asigna el espacio más próximo según el nivel dentro de una ventana de tiempo por nivel, y el paciente no ve calendario en una urgencia. Los horarios de urgencia los define el médico y son solo para urgencias; una urgencia también puede usar horarios convencionales libres. Sin espacio dentro de la ventana: se muestra el móvil de emergencias del médico y el aviso de acudir a un hospital cuando aplique. Con espacio: se agenda de inmediato y se confirma por correo. El triaje no se guarda: solo el tipo de cita; la agenda lo muestra con una etiqueta. El aviso de urgencia al médico lleva solo la categoría, día y hora, sin nombre del paciente, y la categoría se borra al entregarse (o a las 24 h). Anticipación mínima propia (30 min), exentas del límite de cancelación, y protecciones contra abuso (una urgencia activa por paciente, 3 solicitudes por cuenta cada 24 h, CAPTCHA, límites por IP). Los registros nunca incluyen la categoría."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El paciente pide una cita de urgencia y se le asigna el espacio más próximo (Priority: P1)

Un paciente con sesión iniciada, en el micrositio de su consultorio, elige «Tengo una urgencia». Responde el triaje eligiendo **una** de las cinco opciones con semáforo que describe su situación (por ejemplo, dolor muy intenso, sangrado, golpe, diente roto, molestia leve), indica para quién es (él mismo o uno de sus pacientes adicionales) y resuelve la verificación anti-abuso (CAPTCHA). No ve ningún calendario: el sistema busca el espacio más próximo que cumpla la anticipación mínima de urgencias y que caiga dentro de la ventana de tiempo que corresponde al nivel elegido. Si lo encuentra, la cita queda agendada en ese momento y la pantalla le muestra día, hora, consultorio y, si el nivel lo amerita, indicaciones provisionales mientras llega.

**Why this priority**: Es el motivo de la feature: que quien tiene dolor o un accidente consiga atención con el consultorio rápido y sin tener que revisar un calendario, y que el médico no pierda esa cita por un doble agendado.

**Independent Test**: Con un médico con micrositio publicado y horarios de urgencia configurados, un paciente con sesión pide una urgencia de cada nivel y comprueba que se le asigna el espacio más próximo dentro de la ventana de ese nivel, que la cita queda marcada como urgencia en la agenda y que nunca se asigna un espacio ya ocupado.

**Acceptance Scenarios**:

1. **Given** un consultorio con horarios de urgencia libres, **When** un paciente elige un nivel y envía la solicitud, **Then** se agenda el espacio libre más próximo (de urgencia o convencional) que cumple la anticipación mínima de urgencias y cae dentro de la ventana del nivel, y se le muestra el resumen.
2. **Given** un espacio de urgencia y un espacio convencional libres al mismo tiempo, **When** se asigna, **Then** gana el más próximo en el tiempo; a igual hora se prefiere el espacio de urgencia para conservar los convencionales.
3. **Given** una urgencia en curso, **When** el paciente la solicita, **Then** no ve calendario ni lista de horarios, ni puede elegir hora: solo recibe el resultado de la asignación.
4. **Given** una cita de urgencia agendada, **When** el médico o su recepción abren la agenda, **Then** la cita aparece con una etiqueta «Urgencia» y sin la categoría del triaje (que no se guardó).
5. **Given** que el paciente no marcó la casilla de autorización de datos con ese consultorio (cuando todavía no hay una autorización activa), **When** solicita la urgencia, **Then** no puede continuar hasta marcarla (misma regla de la feature 3).
6. **Given** dos solicitudes simultáneas que competirían por el mismo espacio, **When** se procesan, **Then** una obtiene el espacio y la otra recibe el siguiente más próximo dentro de su ventana, o «sin espacio» si no hay; nunca quedan dos citas vigentes en el mismo espacio.
7. **Given** una persona de recepción, **When** intenta pedir una urgencia en nombre de un paciente por este flujo, **Then** el sistema lo niega: este flujo es solo del paciente (el personal agenda con la agenda de la feature 2).
8. **Given** el paso de señales de alarma, **When** el paciente marca «dificultad para tragar o respirar» o «hinchazón cerca del ojo», **Then** no puede continuar con la cita: ve solo el aviso de acudir de inmediato a un hospital o a emergencias y el móvil de emergencias del médico; no se crea cita, no se avisa al médico, no cuenta para el límite de solicitudes y no se guarda que marcó la señal.
9. **Given** que el paciente no marcó ninguna señal de alarma, **When** elige la categoría, **Then** el flujo sigue con la asignación del espacio según el nivel (Rojo 2 h, Naranja 12 h, Amarillo 24 h, Verde claro 48 h, Verde 72 h; valores provisionales).

---

### User Story 2 - Sin espacio: el paciente ve cómo comunicarse con el médico (Priority: P1)

Cuando no hay ningún espacio libre dentro de la ventana del nivel elegido, el paciente ve un mensaje claro de que no se encontró espacio, el **móvil de emergencias** del médico para llamarle, y —cuando el nivel lo amerita— el aviso de acudir a un hospital. No se agenda nada ni se envía aviso al médico.

**Why this priority**: Una urgencia sin respuesta es peor que no ofrecerla; este es el camino de seguridad cuando el consultorio no puede atender.

**Independent Test**: Con un consultorio sin espacios dentro de la ventana, pedir una urgencia de un nivel alto y comprobar que se muestra el móvil de emergencias y el aviso de hospital, que no se creó ninguna cita y que no se envió ningún correo.

**Acceptance Scenarios**:

1. **Given** que no hay espacio libre dentro de la ventana del nivel, **When** el paciente solicita la urgencia, **Then** ve «No encontramos espacio», el móvil de emergencias del médico y el aviso de acudir a un hospital si el nivel lo requiere; no se crea ninguna cita.
2. **Given** un consultorio sin horarios de urgencia pero con espacios convencionales libres dentro de la ventana, **When** se solicita, **Then** se usa el espacio convencional libre más próximo.
3. **Given** un consultorio publicado cuyo médico no tiene móvil de emergencias verificado, **When** no hay espacio, **Then** se muestra el teléfono del consultorio en su lugar y el aviso de hospital.
4. **Given** una solicitud sin espacio, **When** el paciente la repite, **Then** cuenta para el límite de solicitudes por cuenta (ver User Story 4).

---

### User Story 3 - El médico configura sus horarios de urgencia (Priority: P1)

El médico, desde la configuración de su agenda, define en qué franjas de la semana atiende urgencias (por ejemplo, de lunes a sábado de 8:00 a 9:00) y con cuánta anticipación mínima acepta una urgencia (30 minutos por defecto). Esas franjas no aparecen en el calendario convencional del paciente y solo las usa el triaje; en la agenda del personal se ven con su etiqueta.

**Why this priority**: Sin horarios de urgencia configurables el médico no controla cuánto de su día reserva a urgencias; la feature debe respetar su agenda.

**Independent Test**: Configurar franjas de urgencia y anticipación; comprobar que el calendario convencional del paciente no las ofrece, que una urgencia sí las usa y que una cita convencional nunca cae en ellas.

**Acceptance Scenarios**:

1. **Given** franjas de urgencia guardadas, **When** el paciente abre el calendario convencional, **Then** esos horarios no aparecen como disponibles.
2. **Given** una anticipación mínima de urgencias de 30 minutos, **When** son las 9:00, **Then** una urgencia solo puede tomar espacios que empiecen a las 9:30 o después.
3. **Given** franjas que se solapan con el horario convencional, **When** el médico intenta guardarlas, **Then** el sistema las rechaza o las trata sin duplicar espacios (un mismo instante nunca es dos espacios).
4. **Given** cambios en los horarios de urgencia, **When** se guardan, **Then** no se modifican las citas ya agendadas.
5. **Given** una persona de recepción, **When** intenta cambiar los horarios o la anticipación de urgencias, **Then** el sistema lo niega: solo el médico los configura.
6. **Given** valores fuera de rango (anticipación negativa o mayor al máximo permitido, franjas que cruzan la medianoche), **When** se guardan, **Then** se rechazan con un mensaje claro.

---

### User Story 4 - Protecciones contra abuso y límites (Priority: P1)

El sistema evita que una persona sature el consultorio con falsas urgencias: una urgencia activa como máximo por paciente, hasta 3 solicitudes por cuenta cada 24 horas, una verificación anti-bots (CAPTCHA) en el paso de urgencia y límites por IP. Al rebasar un límite, el paciente recibe un mensaje claro con la espera.

**Why this priority**: La urgencia da acceso preferente a espacios y avisa al médico en el momento; sin freno es un vector de abuso y de acoso al consultorio.

**Independent Test**: Hacer solicitudes hasta rebasar cada límite y comprobar que se rechazan sin crear citas ni avisos, con el mensaje de espera; probar la solicitud sin CAPTCHA válido.

**Acceptance Scenarios**:

1. **Given** un paciente con una urgencia vigente (agendada y que aún no empieza), **When** pide otra, **Then** se rechaza indicando que ya tiene una urgencia activa (puede cancelarla primero).
2. **Given** una cuenta con 3 solicitudes de urgencia en las últimas 24 horas (con o sin espacio), **When** hace una cuarta, **Then** se rechaza con la hora en que podrá volver a intentar.
3. **Given** una solicitud sin respuesta válida de la verificación anti-bots, **When** se envía, **Then** se rechaza sin buscar espacio, sin agendar y sin contar como solicitud.
4. **Given** muchas solicitudes desde una misma IP, **When** supera el límite, **Then** recibe un rechazo con espera.
5. **Given** que la verificación anti-bots no está disponible (falla del proveedor), **When** un paciente pide una urgencia, **Then** el flujo no se abre a ciegas: se le muestra el móvil de emergencias y el teléfono del consultorio para llamar.
6. **Given** los límites de reserva y de cancelación de la feature 3, **When** se agenda una urgencia, **Then** esta no consume los cupos de reservas convencionales ni de citas vigentes (tiene sus propios límites).

---

### User Story 5 - El médico recibe el aviso de urgencia sin datos del paciente (Priority: P1)

Cuando se agenda una urgencia, el médico recibe un correo (a su cuenta, no a recepción) con la **categoría** de la urgencia (una de las cinco de la lista fija), el día y la hora, **sin el nombre del paciente**. La categoría no se guarda en la cita: solo vive en la cola de envío y se borra al entregarse el correo o, a más tardar, a las 24 horas. Si el envío falla definitivamente, el médico recibe un aviso genérico sin categoría («tienes una urgencia agendada, revisa tu agenda»). El paciente recibe su confirmación por correo, con el médico como Reply-To.

**Why this priority**: El médico debe enterarse a tiempo de una urgencia sin que el sistema acumule datos de salud (constitución I).

**Independent Test**: Agendar urgencias de cada categoría; comprobar el contenido del correo al médico, que la categoría desaparece de la cola tras la entrega o a las 24 h, que un fallo de envío produce el aviso genérico, y que ninguna tabla ni registro conserva la categoría.

**Acceptance Scenarios**:

1. **Given** una urgencia agendada, **When** el correo se entrega, **Then** el médico lo recibe con categoría, día y hora y sin nombre del paciente ni datos de contacto, y la categoría se elimina de la cola en ese momento.
2. **Given** un correo no entregado a las 24 horas (o tras agotar los reintentos), **When** vence el plazo, **Then** la categoría se borra de la cola y se envía al médico el aviso genérico sin categoría.
3. **Given** una urgencia agendada, **When** se consulta la base de datos, los registros técnicos, el registro de acciones y las métricas, **Then** en ninguno aparece la categoría ni el contenido del triaje; solo consta que la cita es de tipo urgencia.
4. **Given** un paciente, **When** se agenda su urgencia, **Then** recibe un correo de confirmación con día, hora, consultorio y teléfono, con el médico como Reply-To, y sin la categoría.
5. **Given** que la urgencia se cancela antes de que el correo salga, **When** el procesamiento de la cola corre, **Then** el aviso de «urgencia agendada» no se envía (se envía el de cancelación).
6. **Given** una persona de recepción, **When** se agenda una urgencia, **Then** no recibe el aviso con la categoría (solo el médico).

---

### User Story 6 - El paciente cancela su urgencia cuando quiera (Priority: P2)

El paciente puede cancelar su cita de urgencia en cualquier momento antes de que empiece, sin el límite de 24 horas de las citas convencionales. El médico recibe un aviso por correo de la cancelación (sin categoría). El espacio queda libre.

**Why this priority**: Evita que el médico espere a alguien que ya no va, y respeta que en una urgencia el plazo de 24 h no tiene sentido.

**Independent Test**: Agendar una urgencia para dentro de 40 minutos y cancelarla: debe permitirse, liberar el espacio y avisar al médico.

**Acceptance Scenarios**:

1. **Given** una urgencia que empieza en menos de 24 horas, **When** el paciente la cancela, **Then** se permite, se libera el espacio y el médico recibe el aviso de cancelación.
2. **Given** una urgencia ya iniciada o pasada, **When** se intenta cancelar, **Then** se rechaza como en las citas convencionales.
3. **Given** una urgencia cancelada, **When** el paciente pide otra, **Then** puede hacerlo dentro de sus límites (la cancelada ya no cuenta como «activa», pero sí como solicitud de las últimas 24 h).
4. **Given** el enlace del correo de confirmación de una urgencia, **When** el paciente lo abre, **Then** se aplican las mismas reglas de la feature 3 (abrirlo no cambia nada; cancelar exige sesión y un botón con CSRF) sin el límite de 24 horas.
5. **Given** una cancelación de urgencia, **When** el personal del consultorio la ve en la agenda, **Then** consta quién canceló y cuándo, como en cualquier cita.

---

### User Story 7 - Micrositio sin servicio y contenido provisional (Priority: P2)

Si el consultorio no acepta reservas en línea (micrositio despublicado, médico no aprobado o cuenta en solo lectura), no se ofrece el botón de urgencia y se muestra que confirme directamente por teléfono. Los textos del triaje (descripciones de las cinco opciones, indicaciones de primeros auxilios y aviso de acudir a un hospital) son **provisionales** hasta que un dentista los valide; en producción no se muestran a pacientes reales mientras sigan siendo provisionales.

**Why this priority**: Mantiene la coherencia con la feature 3 y cumple la constitución (el contenido médico lo valida un dentista antes de mostrarse a pacientes reales).

**Independent Test**: Despublicar el micrositio y comprobar que no se puede pedir una urgencia; en modo producción con textos provisionales, comprobar que la función de urgencia queda bloqueada con un mensaje de que se confirme por teléfono.

**Acceptance Scenarios**:

1. **Given** un micrositio despublicado, un médico no aprobado o una cuenta en solo lectura, **When** se intenta pedir una urgencia, **Then** se rechaza y se indica que se confirme directamente con el consultorio por teléfono.
2. **Given** que el contenido médico del triaje sigue marcado como provisional en producción, **When** un paciente abre el flujo de urgencia, **Then** no se muestran los textos provisionales y se le indica llamar al consultorio (el comportamiento equivalente al de los textos legales provisionales).
3. **Given** la aprobación del contenido por un dentista, **When** se publica la versión revisada, **Then** el flujo de urgencia queda disponible y la versión mostrada se puede identificar.

---

### Edge Cases

- **Urgencia fuera del horario**: la ventana de un nivel termina antes de que abra el consultorio → «sin espacio» con el móvil de emergencias.
- **Cambio de hora** (zona horaria del consultorio): los espacios de urgencia y las ventanas se calculan en la zona del consultorio sin duplicar ni perder horarios.
- **Reloj y borde de anticipación**: un espacio que empieza justo en el límite de la anticipación mínima de urgencias se acepta (borde inclusivo).
- **Médico con teléfono de emergencias sin verificar**: se muestra el teléfono del consultorio y el aviso de hospital (nunca un número sin verificar).
- **Paciente adicional (menor)**: la urgencia queda a nombre del menor con la autorización del tutor; la regla «una urgencia activa por paciente» aplica por persona, y el tope de 3 solicitudes por cuenta.
- **Paciente cuyo vínculo con el consultorio está revocado**: reservar una urgencia reactiva el vínculo con una nueva autorización, igual que una reserva convencional.
- **Doble envío del formulario**: la misma petición enviada dos veces no crea dos citas ni cuenta dos veces para el límite.
- **Cancelación y asignación simultáneas** sobre el mismo espacio: como máximo una cita vigente por espacio.
- **Correo que falla**: la cita no se deshace; el médico recibe el aviso genérico y la categoría se elimina.
- **Reintentos del cron**: procesar la cola varias veces nunca envía dos avisos ni deja categorías por más de 24 horas.
- **Bloqueos del médico**: un espacio bloqueado no se asigna a una urgencia (los bloqueos mandan sobre las urgencias).
- **Urgencia con cita convencional existente del mismo paciente**: son independientes; los límites de cada tipo se cuentan por separado.

## Requirements *(mandatory)*

### Functional Requirements

**Solicitud y triaje**

- **FR-001**: El sistema MUST ofrecer, solo a pacientes con sesión iniciada en el micrositio de un consultorio que acepta reservas, la opción «Tengo una urgencia».
- **FR-002**: El sistema MUST presentar el triaje como cinco opciones con semáforo (lista fija de cinco categorías) y exigir que el paciente elija exactamente una; cualquier otro valor MUST rechazarse.
- **FR-003**: El paciente MUST poder indicar para quién es la urgencia: él mismo o un paciente adicional de su cuenta; el servidor MUST comprobar la pertenencia a la cuenta.
- **FR-004**: En una urgencia el paciente MUST NOT ver calendario ni lista de horarios ni elegir hora: solo recibe el resultado de la asignación.
- **FR-005**: Las cinco categorías del triaje tienen una ventana de tiempo máxima por nivel, **provisional** hasta que un dentista la valide: Rojo (2 h), Naranja (12 h), Amarillo (24 h), Verde claro (48 h) y Verde (72 h). Los nombres, descripciones y ventanas viven en el contenido versionado del triaje (FR-032) y pueden ajustarse sin cambiar el flujo.
- **FR-006**: Antes de elegir la categoría, el flujo MUST hacer una pregunta de señales de alarma («dificultad para tragar o respirar» y «hinchazón cerca del ojo»). Si el paciente marca alguna, el sistema MUST **bloquear** la solicitud de cita y mostrar únicamente el aviso de acudir de inmediato a un hospital o a emergencias y el móvil de emergencias del médico; MUST NOT agendar, buscar espacio, contar la solicitud contra el límite de 3 por 24 h ni enviar aviso al médico, y MUST NOT guardar que se marcó la señal.

**Asignación del espacio**

- **FR-007**: El servidor MUST asignar el espacio libre más próximo, de urgencia o convencional, que empiece al menos después de la anticipación mínima de urgencias del médico y dentro de la ventana de tiempo del nivel elegido; un espacio de urgencia MUST preferirse a uno convencional cuando empiezan a la misma hora.
- **FR-008**: El sistema MUST NOT asignar espacios ocupados, bloqueados, pasados ni fuera del horario del consultorio, ni mover o desplazar citas ya agendadas.
- **FR-009**: Buscar el espacio, comprobar el solape con citas y bloqueos, insertar la cita y registrar la acción MUST ocurrir en una sola transacción que bloquea la fila del médico, con el índice único de la cita vigente como respaldo (constitución III); debe existir una prueba automática de solicitudes simultáneas.
- **FR-010**: Cuando no hay espacio dentro de la ventana, el sistema MUST informarlo, mostrar el móvil de emergencias verificado del médico (o, si no lo tiene, el teléfono del consultorio) y el aviso de acudir a un hospital cuando el nivel lo requiera, sin crear cita ni enviar avisos al médico.
- **FR-011**: La cita de urgencia MUST guardar solo su tipo (urgencia o convencional); el sistema MUST NOT guardar la categoría del triaje, las respuestas ni indicios de ellas en ninguna tabla, registro técnico, métrica ni herramienta de errores.
- **FR-012**: La agenda del médico y de recepción MUST mostrar las citas de urgencia con una etiqueta que las distinga de las convencionales.
- **FR-013**: Al agendar la urgencia el sistema MUST crear o reutilizar la relación médico-paciente con la autorización de datos del paciente, con las mismas reglas de la feature 3 (casilla sin marcar si no hay una autorización activa).

**Horarios y configuración del médico**

- **FR-014**: El médico MUST poder definir franjas semanales de urgencia, solo para urgencias; esos horarios MUST NOT aparecer en el calendario convencional del paciente ni asignarse a reservas convencionales.
- **FR-015**: El médico MUST poder configurar la anticipación mínima de urgencias (30 minutos por defecto, dentro de límites razonables que defina el plan); solo el médico, nunca recepción.
- **FR-016**: Un mismo instante MUST NOT contar como dos espacios (urgencia y convencional); las franjas de urgencia que se solapan con el horario convencional MUST resolverse sin duplicar espacios.
- **FR-017**: Cambiar los horarios o la anticipación de urgencias MUST NOT modificar citas ya agendadas.

**Avisos**

- **FR-018**: Al agendarse una urgencia el sistema MUST enviar al paciente (cuenta del tutor si es menor) un correo de confirmación con día, hora, consultorio y teléfono, con el médico como Reply-To, sin la categoría, y con el enlace de la feature 3 para ver o cancelar.
- **FR-019**: El sistema MUST enviar al correo de la cuenta del médico (no a recepción) un aviso de urgencia con la categoría (de la lista fija), el día y la hora, sin nombre del paciente ni datos de contacto.
- **FR-020**: La categoría MUST vivir solo en la cola de envío y MUST eliminarse al entregarse el correo o, a más tardar, a las 24 horas; si el envío falla definitivamente, el médico MUST recibir un aviso genérico sin categoría.
- **FR-021**: Si la urgencia se cancela antes de enviarse el aviso, el aviso de «urgencia agendada» MUST NOT enviarse; el médico MUST recibir el aviso de cancelación.
- **FR-022**: Los avisos de urgencia MUST NOT bloquearse por cuota ni por límites de plan; su entrega a tiempo MUST poder verificarse antes del piloto (el cron corre cada minuto).

**Cancelación**

- **FR-023**: El paciente MUST poder cancelar su cita de urgencia en cualquier momento antes de que empiece, sin el límite de cancelación configurado por el médico; el médico MUST recibir un aviso por correo y el espacio MUST quedar libre.
- **FR-024**: Cancelar MUST quedar registrado (quién y cuándo) y respetar el aislamiento entre cuentas: un paciente solo cancela citas de las personas de su cuenta.

**Protecciones contra abuso**

- **FR-025**: El sistema MUST rechazar una nueva urgencia si el paciente ya tiene una vigente (agendada y que aún no empieza).
- **FR-026**: El sistema MUST limitar a 3 las solicitudes de urgencia por cuenta cada 24 horas, contando también las que terminaron sin espacio, e informar cuándo podrá volver a intentar.
- **FR-027**: El paso de urgencia MUST exigir una verificación anti-bots válida antes de buscar espacio; una solicitud sin ella MUST rechazarse sin agendar y sin contar como solicitud. Si la verificación no está disponible, MUST mostrarse el móvil de emergencias y el teléfono del consultorio en lugar de abrir el flujo sin verificación.
- **FR-028**: El sistema MUST aplicar límites de peticiones por IP al flujo de urgencia y rechazar con espera al rebasarlos.
- **FR-029**: Las urgencias MUST tener cupos propios y MUST NOT consumir los límites de reservas por hora ni de citas vigentes de las citas convencionales de la feature 3.
- **FR-030**: Un doble envío del mismo formulario MUST NOT crear dos citas ni contar dos veces en los límites.

**Disponibilidad del servicio y contenido**

- **FR-031**: Con el micrositio despublicado, el médico no aprobado o la cuenta en solo lectura, el sistema MUST NOT aceptar urgencias en línea y MUST indicar que se confirme directamente con el consultorio por teléfono.
- **FR-032**: Los textos del triaje, las indicaciones de primeros auxilios y el aviso de acudir a un hospital MUST estar versionados y marcados como provisionales hasta que un dentista los valide; en producción, mientras sean provisionales, el flujo MUST NOT mostrarlos a pacientes reales y MUST dirigir a llamar al consultorio.

**Privacidad y registros**

- **FR-033**: Ningún registro técnico, métrica ni herramienta de errores MUST contener la categoría, las respuestas del triaje, nombres, correos ni teléfonos; el registro de acciones MUST conservar solo quién, qué (urgencia solicitada, agendada, sin espacio, cancelada), cuándo y resultado, sin la categoría.
- **FR-034**: Toda entrada del flujo (categoría, paciente, respuesta de la verificación anti-bots, identificadores) MUST validarse en el servidor; el médico del consultorio MUST salir del enlace del micrositio y nunca de un dato del cliente.
- **FR-035**: Los avisos de privacidad y la autorización de datos MUST seguir las reglas de la constitución (casilla sin marcar, registro de quién, qué versión y cuándo).

### Key Entities *(include if feature involves data)*

- **Cita de urgencia**: una cita (feature 2) cuyo tipo es «urgencia» en lugar de «convencional». Es lo único que se guarda del triaje: el tipo. No guarda categoría ni respuestas.
- **Horario de urgencia**: franja semanal, definida por el médico, que solo se ofrece a las urgencias; tiene la misma zona horaria y duración de espacio del consultorio.
- **Configuración de urgencias del médico**: anticipación mínima de urgencias (30 min por defecto) y, en su caso, el estado de las franjas; forma parte de la configuración de la agenda.
- **Solicitud de urgencia (contador)**: constancia mínima, sin categoría ni contenido, de que una cuenta pidió una urgencia en cierto momento (con resultado: agendada o sin espacio), para aplicar el límite de 3 cada 24 horas; se conserva el tiempo mínimo necesario.
- **Aviso de urgencia en cola**: correo al médico con la categoría en su carga útil; la categoría se elimina al entregarse o a las 24 h.
- **Contenido del triaje (versionado)**: textos de las cinco opciones, primeros auxilios y aviso de hospital, con su versión y su estado (provisional o validado).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un paciente con sesión completa la solicitud de urgencia y ve su resultado (cita o «sin espacio») en menos de 1 minuto, sin elegir fecha ni hora.
- **SC-002**: En 100 % de las pruebas de solicitudes simultáneas sobre el mismo espacio hay como máximo una cita vigente por espacio, y ninguna solicitud con espacio disponible dentro de su ventana termina en «sin espacio» por una carrera.
- **SC-003**: El médico recibe el aviso de una urgencia agendada en menos de 3 minutos en el 98 % de los casos, con el cron por minuto del hosting compartido.
- **SC-004**: En 100 % de las revisiones automáticas de base de datos, registros técnicos, registro de acciones y correos de confirmación, no aparece la categoría del triaje fuera de la cola de envío, y desaparece de ella a más tardar a las 24 horas.
- **SC-005**: Cuando no hay espacio, el paciente ve el número de emergencias del médico y el aviso de hospital en la misma pantalla de resultado en el 100 % de los casos.
- **SC-006**: Ninguna solicitud por encima de los límites (una activa, 3 por 24 h, sin verificación anti-bots, exceso por IP) agenda una cita ni envía un aviso al médico.
- **SC-007**: Un paciente puede cancelar una urgencia que empieza en menos de 24 horas y el espacio vuelve a estar disponible en el mismo momento; el médico recibe el aviso de cancelación.
- **SC-008**: Entre los médicos del piloto, medir la proporción de urgencias con espacio frente a «llama al médico» para decidir ajustes de ventanas y horarios de urgencia.

## Assumptions

- **Dependencias**: se reutilizan las cuentas de paciente, sesión, pacientes adicionales, autorización de datos, enlaces de correo, outbox y cron de las features 1 a 3; la agenda y el índice único de la feature 2.
- **Alcance del piloto**: los avisos de urgencia salen **solo por correo**. WhatsApp, las cuotas de mensajes por plan y el cobro excedente son posteriores al piloto y quedan fuera.
- **Verificación anti-bots**: se exige una (CAPTCHA); la elección del proveedor y su impacto en privacidad se resuelven en el plan, y debe poder cumplirse sin enviar datos del paciente ni la categoría al proveedor.
- **Móvil de emergencias**: ya existe y se verifica en el registro del médico (feature 1); el teléfono del consultorio es el respaldo si no hay móvil verificado.
- **Una persona, una urgencia activa**: se cuenta por paciente (titular o adicional); las 3 solicitudes por 24 h se cuentan por cuenta.
- **Duración del espacio**: una urgencia usa la misma duración de espacio que la configuración del consultorio.
- **Sin desplazamiento de citas**: una urgencia nunca desplaza una cita ya agendada; solo toma espacios libres.
- **Tabla de triaje (decidida por el responsable, provisional hasta la validación dental)**: cinco niveles de semáforo con una ventana máxima por nivel: Rojo (2 h), Naranja (12 h), Amarillo (24 h), Verde claro (48 h) y Verde (72 h). Las descripciones de cada opción, las indicaciones de primeros auxilios, la pregunta de señales de alarma y el aviso de hospital son texto provisional que un dentista valida antes de producción.
- **Señales de alarma**: decisión del responsable (2026-11-23): bloquean la solicitud y dirigen a emergencias (FR-006); el comportamiento más prudente para el piloto.
- **Cancelación y límites de la feature 3**: las citas de urgencia están exentas del límite de cancelación configurable, pero siguen sujetas al tope de cancelaciones por hora de la cuenta como protección contra abuso.
- **Fuera de alcance**: WhatsApp, cobro con Openpay, panel de soporte completo, historial clínico, reprogramación, duraciones por tipo de tratamiento y conservar el resultado del triaje.
