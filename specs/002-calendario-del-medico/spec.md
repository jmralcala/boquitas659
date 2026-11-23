# Feature Specification: Calendario del médico (agenda)

**Feature Branch**: `002-calendario-del-medico` (sin rama dedicada; se trabaja en `main`)

**Created**: 2026-11-22

**Status**: Draft

**Input**: User description: "Feature 2: Calendario del médico (agenda). Cada médico aprobado tiene un solo calendario con duración de espacios, intervalo, zona horaria, horario semanal y anticipación mínima y máxima configurables por médico. Bloqueo y desbloqueo de horarios solo sobre horarios sin cita (si hay citas, se rechaza indicando cuáles y hay que cancelarlas antes). Agenda por día y semana para el médico y su recepción, con creación y cancelación de citas, sin doble reserva, con aviso por correo al paciente."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El médico configura su calendario (Priority: P1)

Un médico aprobado abre la configuración de su calendario y define: la duración de cada espacio, el intervalo entre espacios, la zona horaria de su consultorio, su horario de atención semanal (por cada día, una o varias franjas, por ejemplo mañana y tarde) y la anticipación mínima y máxima con que los pacientes pueden reservar. Con eso el sistema calcula los espacios disponibles de cada día. Si no cambia nada, rige un conjunto de valores por defecto.

**Why this priority**: Sin configuración no hay espacios, y sin espacios no se puede agendar nada; todo lo demás depende de esto.

**Independent Test**: Con un médico aprobado, guardar una configuración y comprobar que la agenda de la semana siguiente muestra exactamente los espacios que corresponden, en la zona horaria del consultorio.

**Acceptance Scenarios**:

1. **Given** un médico aprobado sin configuración previa, **When** abre su calendario, **Then** ve los valores por defecto (45 min de duración, 15 min de intervalo, zona horaria de Ciudad de México, anticipación mínima de 2 horas y máxima de 60 días) y ningún horario de atención, por lo que todavía no hay espacios.
2. **Given** un horario de lunes a viernes de 9:00 a 14:00 y de 16:00 a 19:00, **When** el médico lo guarda, **Then** la agenda muestra espacios solo en esos días y franjas.
3. **Given** valores fuera de rango (duración de 0 minutos, franjas que se solapan o con la hora de fin antes que la de inicio, anticipación mínima mayor o igual que la máxima, una zona horaria inexistente), **When** intenta guardar, **Then** se rechaza con un mensaje por campo y no se guarda nada.
4. **Given** una persona de recepción con sesión, **When** intenta cambiar la configuración, **Then** el sistema lo niega: solo el médico configura.
5. **Given** una configuración cambiada (otra duración, otro horario, menor anticipación máxima), **When** ya existen citas agendadas, **Then** esas citas se conservan tal cual, y el cambio solo afecta a los espacios y a las reservas nuevas.

---

### User Story 2 - El médico y su recepción ven la agenda por día y por semana (Priority: P1)

El médico (o su recepción, con su médico activo) abre la agenda y ve, por día y por semana, cada espacio con su estado: libre, con cita o bloqueado. Las horas se muestran en la zona horaria del consultorio.

**Why this priority**: Es la herramienta de trabajo diaria del consultorio y la base para crear citas y bloquear horarios.

**Independent Test**: Con citas y bloqueos de prueba, abrir la vista de un día y de una semana y comprobar que cada espacio muestra el estado correcto y que no aparece nada de otro médico.

**Acceptance Scenarios**:

1. **Given** un día con espacios libres, una cita y un bloqueo, **When** el médico abre la vista del día, **Then** ve cada espacio con su estado y, en las citas, el nombre del paciente; el detalle completo del paciente sigue accesible solo por su pantalla propia (con su registro de accesos).
2. **Given** la vista semanal, **When** se abre, **Then** muestra los siete días con sus espacios y estados, y permite pasar a la semana anterior o siguiente.
3. **Given** espacios cuya hora ya pasó, **When** se ve la agenda, **Then** no se ofrecen como libres para agendar.
4. **Given** una persona de recepción vinculada a dos médicos, **When** cambia de médico activo, **Then** ve solo la agenda del médico elegido, nunca la del otro.
5. **Given** una persona de recepción cuyo vínculo con el médico se retiró, **When** abre la agenda, **Then** se le niega el acceso en esa misma petición.

---

### User Story 3 - El médico o su recepción crean una cita en un espacio libre (Priority: P1)

Desde la agenda, el médico o su recepción eligen un espacio libre y un paciente que ya tiene cuenta, y crean la cita. La cita queda agendada en ese momento, se crea la relación médico-paciente si no existía y el paciente recibe un correo informativo. Dos personas que intenten agendar el mismo espacio a la vez nunca producen una doble reserva.

**Why this priority**: Es el valor central de la agenda y la regla de no doble reserva es una invariante del producto.

**Independent Test**: Crear una cita en un espacio libre, comprobar que el espacio pasa a ocupado, que el paciente quedó vinculado al médico y que llegó el correo; después lanzar varias creaciones simultáneas sobre el mismo espacio y comprobar que solo una prospera.

**Acceptance Scenarios**:

1. **Given** un espacio libre y un paciente con cuenta, **When** se crea la cita, **Then** el espacio queda ocupado por esa cita, el paciente queda vinculado a ese médico y se encola el correo de confirmación al paciente (al tutor, si el paciente es un menor).
2. **Given** un espacio ya ocupado o bloqueado, **When** se intenta crear otra cita en él, **Then** se rechaza con un mensaje claro y el calendario no cambia.
3. **Given** varias personas intentando agendar el mismo espacio a la vez, **When** las peticiones llegan simultáneas, **Then** exactamente una cita se crea y las demás reciben el rechazo.
4. **Given** un espacio que no existe en el horario del médico (fuera de franja, desfasado respecto a la cuadrícula o en el pasado), **When** se intenta agendar, **Then** se rechaza.
5. **Given** un paciente que es un menor bajo un tutor, **When** se agenda para el menor, **Then** la cita queda a nombre del menor y los avisos van al correo del tutor.
6. **Given** una persona sin cuenta de paciente, **When** se intenta agendar para ella, **Then** no es posible: el alta de pacientes queda fuera de esta feature.

---

### User Story 4 - El médico o su recepción cancelan una cita (Priority: P1)

El médico o su recepción cancelan una cita futura en cualquier momento. El espacio queda libre de inmediato y el paciente recibe un correo con el aviso.

**Why this priority**: Es la salida obligada para poder bloquear un horario con citas y una operación diaria del consultorio.

**Independent Test**: Cancelar una cita futura, comprobar que el espacio vuelve a estar libre al instante y que se encoló el correo al paciente; intentar cancelar una cita ya cancelada o ajena.

**Acceptance Scenarios**:

1. **Given** una cita futura, **When** el médico o su recepción la cancelan, **Then** la cita queda cancelada, el espacio queda libre de inmediato, se registra quién la canceló y cuándo, y se encola el correo al paciente.
2. **Given** una cita ya cancelada, **When** se intenta cancelar otra vez, **Then** se rechaza sin repetir el aviso.
3. **Given** una cita de otro médico, **When** se intenta cancelar, **Then** el sistema responde como si no existiera.
4. **Given** una cita cuya hora ya pasó, **When** se intenta cancelar, **Then** se rechaza (ya no hay un espacio que liberar).
5. **Given** una cancelación y una creación simultáneas sobre el mismo espacio, **When** ocurren a la vez, **Then** el calendario queda consistente: el espacio tiene como máximo una cita vigente.

---

### User Story 5 - El médico o su recepción bloquean y desbloquean horarios (Priority: P2)

Cuando el médico no atiende (una reunión, un día libre, vacaciones), él o su recepción bloquean un espacio suelto o un rango de fechas y horas. **Solo se pueden bloquear horarios sin cita.** Si el espacio o el rango incluye citas, el bloqueo se rechaza por completo, se indica cuáles son esas citas y hay que cancelarlas primero (con el aviso al paciente) para poder bloquear. Un bloqueo puede deshacerse en cualquier momento.

**Why this priority**: Es la forma de cerrar la agenda sin tocar citas ya acordadas; es muy valiosa pero la agenda funciona sin ella.

**Independent Test**: Bloquear un rango libre y comprobar que los espacios dejan de estar disponibles; intentar bloquear un rango con una cita y comprobar que se rechaza con la lista y que no cambia nada; cancelar la cita y repetir el bloqueo con éxito; desbloquear.

**Acceptance Scenarios**:

1. **Given** un rango sin citas, **When** se bloquea, **Then** todos sus espacios quedan bloqueados y no se pueden agendar.
2. **Given** un rango que incluye una o más citas, **When** se intenta bloquear, **Then** el bloqueo se rechaza completo (no se bloquea ni un espacio), con un mensaje que lista cada cita en conflicto (fecha, hora y nombre del paciente) e indica que deben cancelarse antes.
3. **Given** el rechazo anterior, **When** el médico cancela esas citas y repite el bloqueo, **Then** el bloqueo se aplica.
4. **Given** un bloqueo vigente, **When** se desbloquea, **Then** sus espacios vuelven a estar libres y disponibles.
5. **Given** un bloqueo y una reserva simultáneos sobre el mismo horario, **When** ocurren a la vez, **Then** nunca resultan ambos: o se crea la cita y el bloqueo se rechaza por conflicto, o se aplica el bloqueo y la cita se rechaza.
6. **Given** un rango que termina antes de este momento, **When** se intenta bloquear, **Then** se rechaza.
7. **Given** la persona de recepción, **When** bloquea o desbloquea, **Then** puede hacerlo con la misma regla, y cada acción queda registrada a su nombre.

---

### Edge Cases

- Cambio de configuración con citas existentes: las citas se conservan aunque queden fuera del nuevo horario, con otra duración o más allá de la nueva anticipación máxima; la agenda las sigue mostrando (y las marca si quedan fuera del horario actual). Solo se ofrecen como espacios libres los que cumplen la configuración vigente.
- Reducir la anticipación máxima nunca cancela citas: el límite solo afecta a reservas nuevas.
- Cambio de hora (horario de verano) en una zona horaria que lo aplica: los espacios se definen en la hora local del consultorio; el día con una hora que no existe no ofrece espacios en ella, y el día con una hora repetida no genera espacios duplicados.
- Franjas que terminan a mitad de un espacio: el último espacio incompleto no se ofrece.
- Un rango de bloqueo muy largo (por ejemplo vacaciones de varias semanas) sobre días sin horario de atención: se acepta; solo cuenta lo que afecta a espacios existentes.
- Dos bloqueos que se solapan: se aceptan y un espacio está bloqueado si cualquier bloqueo lo cubre; desbloquear uno no libera lo que otro todavía cubre.
- Bloqueos y citas simultáneas, o cancelaciones simultáneas: el calendario nunca queda con un espacio ocupado y bloqueado a la vez, ni con dos citas vigentes en el mismo espacio.
- Un médico que deja de estar aprobado (rechazado o bloqueado): su agenda deja de ser accesible; las citas existentes se conservan sin cambios.
- Un paciente que borra su cuenta o pide sus derechos: el comportamiento de las citas ante el borrado queda fuera de esta feature (retención y borrado siguen sin definir).
- El correo del paciente no se puede entregar: la cita no se deshace; se registra el fallo de entrega como en cualquier correo.

## Requirements *(mandatory)*

### Functional Requirements

**Calendario y configuración**

- **FR-001**: Cada médico aprobado MUST tener un solo calendario. Un médico pendiente, rechazado o sin ficha MUST NOT acceder a calendario alguno (403).
- **FR-002**: El calendario MUST permitir configurar la duración de los espacios (por defecto 45 minutos), el intervalo entre espacios (por defecto 15 minutos), la zona horaria del consultorio (por defecto Ciudad de México), el horario de atención semanal y la anticipación mínima y máxima de reserva.
- **FR-003**: La duración MUST estar entre 15 y 180 minutos en pasos de 5, y el intervalo entre 0 y 60 minutos en pasos de 5.
- **FR-004**: El horario semanal MUST admitir, por cada día de la semana, cero, una o varias franjas con hora de inicio y de fin en la hora local del consultorio; las franjas de un mismo día MUST NOT solaparse y el fin MUST ser posterior al inicio.
- **FR-005**: La anticipación mínima MUST estar entre 0 horas y 7 días (por defecto 2 horas) y la máxima entre 1 y 365 días (por defecto 60 días); la mínima MUST ser menor que la máxima.
- **FR-006**: Las anticipaciones MUST ser configurables por médico y el servidor MUST comprobarlas en cada reserva hecha por un paciente (feature 3); el médico y su recepción pueden agendar en cualquier espacio libre futuro, sin que se les apliquen las anticipaciones.
- **FR-007**: Solo el médico MUST poder cambiar la configuración; la recepción MUST NOT poder hacerlo (403).
- **FR-008**: Todo valor inválido MUST rechazarse con un mensaje por campo y sin guardar nada parcial.
- **FR-009**: Los cambios de configuración MUST afectar solo a los espacios futuros y a las reservas nuevas; las citas existentes MUST conservarse tal cual en cualquier caso.

**Espacios y agenda**

- **FR-010**: Los espacios de cada día MUST generarse a partir del horario semanal, la duración y el intervalo, con las horas guardadas en UTC y mostradas en la zona horaria del consultorio. El intervalo es la pausa entre citas consecutivas: dentro de cada franja, los espacios empiezan cada «duración + intervalo» (con 45 + 15 min, a las 9:00, 10:00, 11:00…) y nunca se solapan; un espacio ocupa solo su duración y el intervalo queda libre como descanso.
- **FR-011**: Cada espacio MUST tener uno de tres estados: libre, ocupado por una cita vigente o bloqueado. Los espacios cuya hora ya pasó MUST NOT ofrecerse como libres.
- **FR-012**: El médico y su recepción MUST poder ver la agenda por día y por semana, con navegación a otras fechas.
- **FR-013**: La agenda MUST mostrar el nombre del paciente en cada cita; el resto de sus datos de contacto MUST seguir disponibles solo en la pantalla de detalle, cuyo acceso queda registrado.
- **FR-014**: Una cita que queda fuera del horario o de la configuración vigentes MUST seguir mostrándose y MUST marcarse como tal.

**Citas**

- **FR-015**: El médico y su recepción MUST poder crear una cita en un espacio libre para un paciente que ya tenga cuenta (el propio titular o un paciente adicional bajo un tutor). La cita MUST quedar agendada en ese momento, sin confirmación posterior del paciente.
- **FR-016**: Para elegir al paciente, el sistema MUST ofrecer los pacientes ya vinculados con el médico y la búsqueda de una cuenta por su correo exacto; esa búsqueda MUST estar limitada en frecuencia y MUST quedar registrada.
- **FR-017**: Al crear la cita, el sistema MUST crear la relación médico-paciente si no existía, de forma que el paciente quede en el ámbito de ese médico y de ninguno otro.
- **FR-018**: Un espacio MUST tener como máximo una cita vigente: la no doble reserva MUST cumplirse aun con peticiones simultáneas, incluso entre una creación y una cancelación del mismo espacio.
- **FR-019**: La creación MUST rechazarse si el espacio no existe en la configuración vigente, está en el pasado, está ocupado o está bloqueado.
- **FR-020**: Al crear una cita, el sistema MUST encolar un correo informativo al paciente (al correo del tutor si es un menor) con fecha, hora y consultorio.
- **FR-021**: El médico y su recepción MUST poder cancelar una cita futura en cualquier momento; la cancelación MUST liberar el espacio de inmediato, registrar quién cancela y cuándo, y encolar un correo de aviso al paciente (al tutor si es un menor).
- **FR-022**: Cancelar una cita ya cancelada o cuya hora ya pasó MUST rechazarse sin repetir avisos.
- **FR-023**: Cada cita MUST registrar su inicio y fin (UTC), el paciente, el médico, quién la creó, su estado (vigente o cancelada) y, si se cancela, quién y cuándo.

**Bloqueos**

- **FR-024**: El médico y su recepción MUST poder bloquear un espacio suelto o un rango (de una fecha y hora a otra, también de varios días) y desbloquear un bloqueo propio completo.
- **FR-025**: Bloquear MUST rechazarse por completo si algún espacio del rango tiene una cita vigente; el rechazo MUST listar cada cita en conflicto (fecha, hora y nombre del paciente) e indicar que debe cancelarse primero. MUST NOT bloquearse ningún espacio de forma parcial.
- **FR-026**: Un bloqueo MUST NOT cancelar, mover ni alterar jamás una cita.
- **FR-027**: Bloquear y reservar a la vez sobre un mismo horario MUST resolverse de forma que nunca resulten un bloqueo y una cita vigente sobre el mismo espacio.
- **FR-028**: Se MUST rechazar un rango que termine antes de este momento. Los bloqueos solapados MUST aceptarse y un espacio MUST considerarse bloqueado mientras cualquier bloqueo lo cubra.

**Seguridad, aislamiento y registro**

- **FR-029**: Toda consulta o cambio de la agenda MUST filtrarse por el médico mediante el contexto de médico; un médico MUST NOT ver ni afectar la agenda, los bloqueos, las citas ni los pacientes de otro, y un identificador ajeno MUST responder como si no existiera.
- **FR-030**: El acceso de la recepción MUST revalidarse en cada petición contra su vínculo vigente con el médico activo.
- **FR-031**: Toda operación que cambia estado MUST estar protegida contra peticiones falsificadas y toda entrada MUST validarse en el servidor.
- **FR-032**: Cada acción (configurar, crear o cancelar cita, bloquear, desbloquear) MUST registrar quién la hizo y cuándo, sin contenido clínico, y las de la recepción MUST quedar a nombre de la persona.
- **FR-033**: Los registros técnicos MUST NOT contener nombres, correos ni teléfonos de pacientes.

### Key Entities

- **Calendario**: el único calendario de un médico aprobado, con su configuración vigente.
- **Configuración del calendario**: duración de los espacios, intervalo, zona horaria, anticipación mínima y máxima.
- **Franja de atención**: un intervalo de horas de un día de la semana en que el médico ofrece espacios.
- **Espacio**: un hueco de tiempo calculado a partir de la configuración; su estado (libre, ocupado, bloqueado) se deriva de las citas y los bloqueos.
- **Cita**: un espacio ocupado por un paciente; tiene inicio, fin, paciente, médico, quién la creó, estado y datos de cancelación.
- **Bloqueo**: un rango de fecha y hora, con motivo opcional y privado, que cierra espacios sin cita.
- **Relación médico-paciente**: vínculo que delimita qué pacientes ve cada médico (ya existe en la feature 1).
- **Registro de acciones**: quién hizo qué sobre la agenda y cuándo.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un médico configura su calendario completo (duración, intervalo, horario semanal y anticipaciones) en menos de 5 minutos.
- **SC-002**: La persona de recepción crea una cita en un espacio libre en menos de 1 minuto desde que abre la agenda.
- **SC-003**: En las pruebas de concurrencia (al menos 20 intentos simultáneos sobre un mismo espacio), exactamente una cita se crea y 0 espacios terminan con dos citas vigentes.
- **SC-004**: En las pruebas de concurrencia entre bloqueos y reservas, 0 espacios terminan bloqueados y ocupados a la vez, y 0 citas son alteradas por un bloqueo.
- **SC-005**: El 100 % de los rechazos de bloqueo por citas existentes listan todas las citas en conflicto, y 0 bloqueos parciales.
- **SC-006**: En las pruebas de aislamiento, 0 casos en que un médico o su recepción vean o cambien agenda, citas o pacientes de otro médico.
- **SC-007**: Tras cancelar una cita, el espacio se muestra libre en la siguiente consulta de la agenda y el aviso al paciente se encola en el mismo instante.
- **SC-008**: La vista semanal de la agenda se muestra en menos de 2 segundos con hasta 300 citas en la semana.
- **SC-009**: El 100 % de las acciones sobre la agenda quedan registradas con quién y cuándo.
- **SC-010**: Al menos el 90 % de los médicos del piloto crean su primera cita en la agenda sin ayuda.

## Assumptions

- **Alcance**: esta feature cubre la configuración, la agenda, las citas creadas por el médico o su recepción y los bloqueos. La reserva por el propio paciente y el micrositio son la feature 3; urgencias y triaje, la feature 4. Quedan fuera la ubicación con mapa y el logo, el panel de soporte completo, los recordatorios, WhatsApp, el cobro y la reprogramación.
- **Valores por defecto y límites** (resuelven el supuesto abierto 12 de `0001`, ajustables): duración 45 min (15–180), intervalo 15 min (0–60), anticipación mínima 2 horas (0 h–7 días), anticipación máxima 60 días (1–365 días), zona horaria Ciudad de México.
- **Anticipaciones**: se aplican a las reservas hechas por el paciente (feature 3). El médico y su recepción pueden agendar cualquier espacio libre futuro, por ejemplo una cita de última hora.
- **Reducir la anticipación máxima** no cancela ni toca citas ya agendadas: el nuevo límite solo afecta a reservas nuevas.
- **Conflictos al bloquear**: el sistema rechaza el bloqueo completo y muestra la lista de citas en conflicto con fecha, hora y nombre del paciente; el médico decide cuáles cancelar. No existe un atajo para «cancelar y bloquear en un paso».
- **Solapes tras cambiar la configuración**: un espacio se considera ocupado si cualquier cita vigente se solapa con él (no solo si empieza a la misma hora); así, reducir la duración nunca permite una reserva encima de una cita ya agendada.
- **Citas pasadas y rangos de bloqueo**: al bloquear solo cuentan como conflicto las citas vigentes que aún no han terminado; una cita ya pasada dentro del rango no lo impide.
- **Topes**: el personal puede agendar y consultar hasta 730 días hacia adelante y consultar hasta 365 días hacia atrás, un bloqueo dura como máximo 366 días y cada día del horario semanal admite hasta 4 franjas.
- **Búsqueda de pacientes por correo**: devuelve los nombres de los pacientes de esa cuenta (incluidos menores) y confirma que la cuenta existe; se acepta con el mismo criterio que el alta de pacientes de la feature 1 (oráculo aceptado), con límite de frecuencia y registro.
- **Límites contra el abuso**: la búsqueda por correo admite 30 búsquedas por hora por persona y 60 por médico; crear o cancelar citas, 60 acciones por hora por persona y 5 citas creadas por hora para un mismo paciente. Se aplican a la persona con todos sus médicos y se responde con una espera.
- **Retención**: el registro de acciones de la agenda se conserva 90 días; las citas y los bloqueos no se ven afectados.
- **Correo no entregable**: si el aviso no puede entregarse tras los reintentos, la cita se conserva tal cual y el fallo queda en el informe de entregas.
- **Zonas horarias**: se admite una lista cerrada de zonas de México (por defecto Ciudad de México).
- **Desbloqueo**: se deshace un bloqueo completo; para liberar solo una parte se elimina y se crea otro más pequeño.
- **Varias franjas por día**: el horario de atención admite varias franjas por día (por ejemplo mañana y tarde) porque los consultorios suelen cerrar a mediodía.
- **Pacientes**: solo se agenda para pacientes que ya tienen cuenta; el alta de pacientes por la recepción queda fuera. La búsqueda por correo exacto está limitada en frecuencia y registrada para que no sirva de directorio.
- **Tipo de cita**: en esta feature todas las citas son convencionales; las urgencias llegan en la feature 4.
- **Correos**: los avisos usan el mismo mecanismo de correo de la feature 1; los mensajes por WhatsApp llegan en una fase posterior.
- **Dependencias**: feature 1 (médicos aprobados, recepción con vínculo vigente, cuentas de pacientes y menores, contexto de médico, registro de accesos y de acciones, correo).
- **Constitución**: la feature está sujeta a los principios II (aislamiento por médico) y III (integridad de la agenda, versión 1.1.0) de `.specify/memory/constitution.md`.
