# Feature Specification: Cuentas y acceso

**Feature Branch**: `001-cuentas-y-acceso` (sin rama dedicada; se trabaja en `main`)

**Created**: 2026-11-21

**Status**: Draft

**Input**: User description: "Feature 1: Cuentas y acceso. Registro del médico con cédula profesional, móvil de emergencias y aprobación manual por soporte; cuenta global del paciente con aislamiento por médico y pacientes adicionales (hijos) bajo el tutor; recepción (hasta 2 personas por médico) con invitación por correo; sesiones y seguridad de cuentas; consentimientos y aviso de privacidad con registro y versionado; registro de accesos al detalle de pacientes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Médico se registra y soporte aprueba su cuenta (Priority: P1)

Un médico dental se registra con su correo, contraseña, cédula profesional (con su foto o documento) y un móvil de emergencias. Antes de subir la cédula acepta el aviso de privacidad propio y los términos y condiciones del servicio. Soporte recibe un aviso por correo, revisa la cédula y la aprueba o la rechaza. Hasta que se aprueba, el médico no accede a nada. Al aprobar, empiezan sus 5 días de prueba y el médico recibe un correo de bienvenida.

**Why this priority**: Sin médicos aprobados no existe producto. Es la puerta de entrada de quien paga y el control de confianza para que los pacientes reserven con profesionales reales.

**Independent Test**: Registrar un médico de prueba, comprobar que no puede acceder, aprobarlo desde la vista mínima de soporte y comprobar que entra y que la prueba queda iniciada ese día.

**Acceptance Scenarios**:

1. **Given** un visitante en el registro, **When** intenta enviar el formulario sin marcar la casilla de aviso de privacidad y términos, **Then** el registro se bloquea y se indica qué falta.
2. **Given** un registro completo y aceptado, **When** se envía, **Then** la cuenta queda "pendiente de aprobación", soporte recibe un correo de aviso (sin adjuntos, con enlace al panel) y el médico ve un mensaje de que está en revisión.
3. **Given** una cuenta pendiente, **When** el médico intenta iniciar sesión, **Then** puede autenticarse pero solo ve el estado de su solicitud, sin acceso a funciones del producto.
4. **Given** una cuenta pendiente, **When** soporte la aprueba, **Then** el médico recibe un correo, obtiene acceso y los 5 días de prueba empiezan en ese momento.
5. **Given** una cuenta pendiente, **When** soporte la rechaza indicando el motivo, **Then** el médico es avisado por correo y no obtiene acceso.
6. **Given** una cédula ya asociada a una cuenta, **When** otra persona intenta registrarse con la misma cédula, **Then** el registro se rechaza con un mensaje que lo dirige a soporte.
7. **Given** un móvil de emergencias ya usado por otra cuenta, o que no es un número móvil, **When** se envía el registro, **Then** se rechaza con un mensaje claro.

---

### User Story 2 - Paciente crea su cuenta global y consiente el aviso de privacidad (Priority: P1)

Un paciente crea una cuenta con nombre, fecha de nacimiento, correo, teléfono y contraseña, y acepta el aviso de privacidad con consentimiento expreso por sus datos de salud. La cuenta es única y global (sirve con cualquier médico), pero cada médico solo ve a los pacientes que se relacionaron con él. El paciente puede añadir pacientes adicionales (por ejemplo hijos) bajo su cuenta de tutor, aceptando el aviso en nombre del menor.

**Why this priority**: Es el otro lado de la plataforma y es donde se recaban los datos sensibles; sin consentimiento válido no puede entrar ningún paciente real.

**Independent Test**: Crear una cuenta de paciente, añadir un menor, y comprobar que los consentimientos quedaron registrados y que la cuenta puede iniciar sesión.

**Acceptance Scenarios**:

1. **Given** el formulario de alta de paciente, **When** se carga, **Then** la casilla del aviso de privacidad aparece sin marcar y el alta no avanza sin marcarla.
2. **Given** un alta válida, **When** se completa, **Then** existe una cuenta con los datos indicados (fecha de nacimiento, no edad) y un registro de aceptación con quién, qué documento, qué versión y cuándo.
3. **Given** un tutor con sesión iniciada, **When** añade un paciente adicional y marca el aviso en nombre del menor, **Then** el menor queda bajo la cuenta del tutor con su propio registro de aceptación.
4. **Given** un correo ya registrado, **When** alguien intenta crear otra cuenta con él, **Then** se le dirige a iniciar sesión (se acepta que esto revele que el correo existe, con límite de peticiones como mitigación).
5. **Given** un paciente con relación con el médico A, **When** el médico B consulta sus pacientes, **Then** no aparece ni se puede obtener su información.

---

### User Story 3 - Inicio de sesión seguro y recuperación de contraseña (Priority: P1)

Todos los usuarios (médicos, recepción, pacientes y soporte) inician sesión con correo y contraseña. Las contraseñas cumplen reglas de calidad, los intentos fallidos se frenan con esperas crecientes, las sesiones caducan por inactividad y quien olvidó su contraseña la recupera con un enlace por correo de un solo uso que vence en 30 minutos. Los cambios sensibles avisan por correo.

**Why this priority**: La plataforma custodia datos de salud; la seguridad de las cuentas es condición de todas las demás historias.

**Independent Test**: Crear usuarios de cada tipo, probar contraseñas débiles, intentos fallidos repetidos, caducidad por inactividad y recuperación con enlace válido, usado y vencido.

**Acceptance Scenarios**:

1. **Given** una contraseña de menos de 10 caracteres, o una contraseña común o conocida por filtraciones, **When** se intenta usar al registrarse o cambiarla, **Then** se rechaza con un mensaje que explica el motivo; contraseñas largas sin símbolos ni mayúsculas se aceptan.
2. **Given** varios intentos fallidos seguidos, **When** se vuelve a intentar, **Then** el sistema exige una espera cada vez mayor y no revela si el fallo fue de correo o de contraseña.
3. **Given** una sesión sin actividad más allá del límite, **When** el usuario vuelve, **Then** debe iniciar sesión de nuevo.
4. **Given** una solicitud de recuperación, **When** se envía cualquier correo (existente o no), **Then** la respuesta en pantalla es idéntica; si la cuenta existe llega un enlace de un solo uso que vence a los 30 minutos.
5. **Given** un enlace de recuperación ya usado o vencido, **When** se abre, **Then** no permite cambiar la contraseña y ofrece pedir uno nuevo.
6. **Given** un cambio de contraseña o un inicio de sesión desde un dispositivo nuevo, **When** ocurre, **Then** el titular recibe un correo de aviso.
7. **Given** una acción sensible (cambiar contraseña, correo o móvil de emergencias), **When** se intenta, **Then** se pide la contraseña de nuevo.

---

### User Story 4 - Médico invita a recepción y controla su acceso (Priority: P2)

Un médico aprobado invita por correo a hasta 2 personas de recepción. La invitación es un enlace de un solo uso que caduca (7 días). La persona acepta el aviso de privacidad propio y el compromiso de confidencialidad, y desde entonces puede ver la agenda y los datos de contacto de los pacientes del médico y crear o cancelar citas, pero no cambiar configuración, pagos, móvil de emergencias ni cédula, ni invitar a otros. El médico puede retirar el acceso en cualquier momento y surte efecto al instante. Una persona puede trabajar con varios médicos.

**Why this priority**: Es necesaria para consultorios con asistente, pero el producto es utilizable sin ella.

**Independent Test**: Invitar a una persona, aceptar la invitación, comprobar permisos permitidos y prohibidos, retirar el acceso y comprobar que la sesión activa deja de funcionar de inmediato.

**Acceptance Scenarios**:

1. **Given** un médico con 2 invitaciones de recepción, **When** intenta crear una tercera, **Then** se rechaza indicando el límite.
2. **Given** una invitación enviada, **When** la persona abre el enlace, acepta el aviso y el compromiso de confidencialidad y fija su contraseña, **Then** queda vinculada al médico; el enlace no se puede reutilizar.
3. **Given** un enlace de invitación caducado o ya usado, **When** se abre, **Then** se rechaza y se indica que pida una nueva al médico.
4. **Given** una persona de recepción con sesión, **When** intenta cambiar configuración, pagos, móvil de emergencias o cédula, o invitar a alguien, **Then** el sistema lo niega.
5. **Given** una persona de recepción con sesión activa, **When** el médico retira su acceso, **Then** su siguiente petición es rechazada.
6. **Given** una persona vinculada a dos médicos, **When** inicia sesión, **Then** elige con qué médico trabaja y solo ve los datos de ese médico en ese momento.
7. **Given** cualquier acción de recepción, **When** se realiza, **Then** queda registrada quién la hizo.

---

### User Story 5 - Aviso de privacidad versionado y siempre accesible (Priority: P2)

Los textos legales (aviso del paciente, aviso del médico, aviso de recepción con compromiso de confidencialidad, términos y condiciones del servicio) se publican por versiones. Cuando una versión cambia, cada persona afectada debe aceptar la nueva antes de continuar. El aviso es consultable en cualquier momento desde el registro y desde sitios públicos del producto. Cada aceptación guarda quién, qué documento, qué versión y cuándo.

**Why this priority**: Es requisito legal de la primera versión (ningún paciente real entra sin esto), pero su mecánica puede construirse con texto provisional.

**Independent Test**: Publicar una versión nueva de un texto y comprobar que la próxima sesión de un usuario ya registrado le exige aceptarla y que se guarda el registro.

**Acceptance Scenarios**:

1. **Given** una versión nueva de un documento legal, **When** un usuario con aceptación anterior inicia sesión, **Then** debe aceptar la nueva versión antes de usar el producto.
2. **Given** un usuario, **When** acepta un documento, **Then** se guarda un registro inmodificable con su identidad, el documento, la versión y la fecha y hora.
3. **Given** cualquier visitante sin sesión, **When** busca el aviso de privacidad, **Then** lo encuentra accesible desde el registro y desde los sitios públicos.
4. **Given** el entorno de producción, **When** un documento está marcado como provisional (sin revisión legal), **Then** no se permite el alta de pacientes, el registro de médicos ni la aceptación de invitaciones de recepción con ese texto.

---

### User Story 6 - Doble factor y registro de accesos a datos de pacientes (Priority: P3)

El personal de soporte debe usar doble factor de autenticación obligatoriamente; médicos y recepción pueden activarlo si quieren. Cada vez que un médico o una persona de recepción abre el detalle de un paciente, queda registrado quién y cuándo, sin contenido, para poder auditarlo.

**Why this priority**: Refuerza la seguridad y la trazabilidad, pero el producto funciona sin ello. El de soporte es el más crítico porque aprueba cuentas.

**Independent Test**: Intentar entrar como soporte sin segundo factor; abrir el detalle de un paciente y comprobar que se añadió una entrada de auditoría.

**Acceptance Scenarios**:

1. **Given** una cuenta de soporte sin doble factor configurado, **When** inicia sesión por primera vez, **Then** se le obliga a configurarlo antes de acceder a cualquier función.
2. **Given** un médico o recepción que activó el doble factor, **When** inicia sesión, **Then** se le pide el segundo factor.
3. **Given** una persona autorizada, **When** abre el detalle de un paciente, **Then** se registra quién, cuándo y de qué paciente, sin copiar datos clínicos ni de contacto.
4. **Given** una persona sin relación con el paciente, **When** intenta abrir su detalle, **Then** se niega y el intento también queda registrado.

---

### Edge Cases

- Un médico se registra pero nunca sube una cédula legible: soporte debe poder rechazar con motivo y el médico corregir y reenviar sin crear otra cuenta.
- Un médico aprobado cuya cédula se registró por error o por otra persona: solo soporte puede liberarla (herramienta de administración mínima, ver supuestos).
- Un correo ya registrado con otro rol se rechaza al registrarse o al invitar, con un mensaje genérico que no revela el rol de la cuenta existente.
- Un tutor intenta eliminar o editar a un paciente adicional con citas existentes: el comportamiento de borrado queda fuera de esta feature (se resuelve con la política de retención).
- Un menor cumple la mayoría de edad: su cuenta sigue bajo el tutor hasta que se defina lo contrario (fuera de alcance).
- Enlaces de invitación o de recuperación abiertos automáticamente por antivirus o clientes de correo: abrir el enlace nunca lo consume; solo la acción de confirmar lo hace.
- Cambio de correo de una cuenta: exige contraseña de nuevo y avisa tanto al correo anterior como al nuevo.
- Soporte aprueba una cuenta mientras el médico ya inició otra solicitud con la misma cédula: la primera aprobada prevalece, la otra queda rechazada.
- Intentos masivos de registro o recuperación desde una sola dirección: se limitan las peticiones y se responde de forma uniforme.

## Requirements *(mandatory)*

### Functional Requirements

**Médicos y aprobación**

- **FR-001**: El sistema MUST permitir el registro de un médico con nombre, correo, contraseña, cédula profesional (número y archivo o foto), móvil de emergencias y teléfono del consultorio (opcional, puede ser fijo y no se verifica).
- **FR-002**: El sistema MUST exigir al médico aceptar su aviso de privacidad y los términos y condiciones del servicio, mediante casillas sin marcar de antemano, antes de poder subir la cédula.
- **FR-003**: El sistema MUST garantizar que una cédula profesional esté asociada como máximo a una cuenta.
- **FR-004**: El sistema MUST garantizar que el móvil de emergencias sea un número móvil y no esté asociado a más de una cuenta.
- **FR-005**: El sistema MUST dejar cada cuenta de médico en estado "pendiente" hasta su aprobación manual, y MUST impedir cualquier función del producto (más allá de ver el estado de la solicitud) mientras esté pendiente o rechazada.
- **FR-006**: El sistema MUST avisar por correo a soporte de cada solicitud nueva, sin adjuntos y con un enlace al panel donde se revisa.
- **FR-007**: El personal de soporte MUST poder, desde una vista mínima, ver las solicitudes pendientes, aprobar o rechazar con motivo y liberar una cédula registrada por error; cada decisión MUST registrar quién la tomó y cuándo.
- **FR-008**: Al aprobar, el sistema MUST iniciar los 5 días de prueba en ese momento y avisar al médico por correo; durante el piloto las cuentas se activan manualmente y sin cobro.
- **FR-009**: El médico rechazado MUST poder corregir y reenviar su solicitud sin crear otra cuenta.
- **FR-010**: La verificación del móvil de emergencias por mensajería queda fuera de esta feature; en esta versión el móvil solo se registra y se valida su formato y unicidad.

**Pacientes**

- **FR-011**: El sistema MUST permitir crear una cuenta de paciente con nombre, fecha de nacimiento (no edad), correo, teléfono y contraseña, sin historial clínico.
- **FR-012**: La cuenta de paciente MUST ser única por correo y global entre médicos.
- **FR-013**: Los datos del paciente MUST guardarse por relación médico-paciente, de modo que cada médico (y su recepción) acceda solo a los pacientes con los que tiene relación.
- **FR-014**: Un paciente MUST poder añadir pacientes adicionales (por ejemplo hijos) bajo su cuenta de tutor; en el detalle visible para el médico de un menor MUST aparecer también el tutor.
- **FR-015**: El sistema MUST calcular la edad a partir de la fecha de nacimiento cuando deba mostrarse.
- **FR-016**: Cuando un correo ya existe, el sistema MUST dirigir a iniciar sesión y limitar las peticiones por origen para mitigar la enumeración de correos.

**Consentimientos y avisos**

- **FR-017**: El paciente MUST aceptar el aviso de privacidad con consentimiento expreso por datos de salud al crear la cuenta; el tutor MUST aceptar el mismo aviso en nombre de cada menor al añadirlo.
- **FR-018**: La persona de recepción MUST aceptar su aviso de privacidad propio y un compromiso de confidencialidad al aceptar la invitación.
- **FR-019**: Todas las casillas de aceptación MUST aparecer sin marcar de antemano y MUST bloquear el avance mientras no se marquen.
- **FR-020**: Cada aceptación MUST registrarse con quién, qué documento, qué versión y cuándo, y el registro MUST ser de solo lectura para los usuarios.
- **FR-021**: Los documentos legales MUST estar versionados; cuando cambie una versión, cada persona afectada MUST aceptarla de nuevo antes de continuar.
- **FR-022**: El aviso de privacidad MUST ser consultable sin sesión desde el registro y desde los sitios públicos del producto.
- **FR-023**: Los documentos marcados como provisionales MUST impedir, en el entorno de producción, el alta de pacientes, el registro de médicos y la aceptación de invitaciones de recepción con ese texto.
- **FR-024**: El sistema MUST ofrecer un canal visible para que los titulares ejerzan sus derechos de acceso, rectificación, cancelación y oposición, con plazo de respuesta definido en el aviso.

**Recepción**

- **FR-025**: Un médico aprobado MUST poder invitar por correo hasta 2 personas de recepción; las invitaciones pendientes cuentan hacia el límite.
- **FR-026**: La invitación MUST ser un enlace de un solo uso que caduca a los 7 días, ligado a esa invitación, y que no cambia estado con solo abrirse.
- **FR-027**: La recepción MUST poder ver la agenda y los datos de contacto de los pacientes del médico y crear o cancelar citas; MUST NOT poder cambiar configuración, pagos, móvil de emergencias ni cédula, ni invitar a otras personas.
- **FR-028**: El médico MUST poder retirar a una persona de recepción, y el acceso MUST cortarse de inmediato, incluyendo sesiones abiertas.
- **FR-029**: Una persona de recepción MUST poder estar vinculada a varios médicos, eligiendo con cuál trabaja en cada sesión, sin mezclar datos entre ellos.
- **FR-030**: Toda acción de recepción MUST registrar quién la realizó.

**Seguridad de cuentas y sesiones**

- **FR-031**: Las contraseñas MUST tener al menos 10 caracteres, sin reglas de composición obligatorias, y MUST rechazarse las comunes o conocidas por filtraciones.
- **FR-032**: Las contraseñas MUST almacenarse de forma que no sean recuperables (nunca en claro ni con cifrado reversible).
- **FR-033**: El sistema MUST limitar los intentos de inicio de sesión con espera creciente y MUST responder igual ante correo inexistente y contraseña incorrecta.
- **FR-034**: La recuperación de contraseña MUST usar un enlace de un solo uso que caduca a los 30 minutos y MUST dar la misma respuesta en pantalla exista o no la cuenta.
- **FR-035**: Las sesiones MUST protegerse contra robo y manipulación (solo accesibles por el navegador, solo por conexión segura y sin envío entre sitios) y MUST caducar por inactividad.
- **FR-036**: El doble factor MUST ser obligatorio para soporte y opcional para médicos y recepción.
- **FR-037**: El sistema MUST avisar por correo a la persona titular ante un cambio de contraseña o un inicio de sesión desde un dispositivo nuevo.
- **FR-038**: Los cambios sensibles (contraseña, correo, móvil de emergencias) MUST pedir la contraseña actual de nuevo.
- **FR-039**: Las acciones que cambian estado y se hacen desde un enlace de correo o desde la sesión MUST estar protegidas contra peticiones falsificadas.

**Aislamiento y auditoría**

- **FR-040**: Toda consulta de datos de pacientes MUST comprobar en el servidor la relación con el médico (o el vínculo de recepción) y no solo que haya sesión.
- **FR-041**: Cada acceso al detalle de un paciente MUST registrarse con quién y cuándo, sin contenido, y los intentos denegados también.
- **FR-042**: Los registros técnicos y las herramientas de errores MUST NOT contener contraseñas, tokens, datos personales ni contenido de mensajes.

### Key Entities

- **Médico**: profesional dental que contrata el servicio. Atributos: nombre, correo, cédula, móvil de emergencias, teléfono del consultorio, estado (pendiente, aprobado, rechazado), fecha de aprobación e inicio de prueba.
- **Cuenta de paciente**: persona con correo y contraseña globales. Es el tutor de los pacientes adicionales que añada.
- **Paciente**: persona atendida (puede ser la cuenta misma o un menor bajo un tutor). Atributos: nombre, fecha de nacimiento, teléfono, correo.
- **Relación médico-paciente**: vínculo que delimita qué datos de un paciente ve cada médico; es la unidad de aislamiento.
- **Persona de recepción**: usuario invitado por uno o más médicos, con permisos limitados.
- **Invitación**: oferta de acceso de recepción, con caducidad y un solo uso.
- **Usuario de soporte**: personal de la plataforma que aprueba solicitudes; requiere doble factor.
- **Documento legal**: texto con tipo (aviso de paciente, aviso de médico, aviso de recepción, términos, compromiso de confidencialidad), versión y marca de provisional o revisado.
- **Aceptación**: registro inmodificable de quién aceptó qué versión de qué documento y cuándo.
- **Sesión**: periodo autenticado de un usuario, con caducidad por inactividad y, en recepción, un médico activo.
- **Registro de acceso**: entrada de auditoría de quién abrió el detalle de qué paciente y cuándo, sin contenido.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un médico completa el registro (incluida la subida de cédula) en menos de 5 minutos.
- **SC-002**: Soporte revisa y resuelve una solicitud de médico en menos de 3 minutos de trabajo efectivo.
- **SC-003**: Un paciente crea su cuenta en menos de 2 minutos.
- **SC-004**: El 100 % de las cuentas de médico pendientes o rechazadas se mantienen sin acceso a funciones del producto en las pruebas de acceso.
- **SC-005**: En las pruebas de aislamiento, 0 casos en que un médico o su recepción obtengan datos de un paciente sin relación con ellos.
- **SC-006**: El 100 % de las altas y aceptaciones tienen un registro con quién, documento, versión y fecha; 0 altas sin aceptación.
- **SC-007**: El 100 % de las aperturas de detalle de paciente, permitidas o denegadas, aparecen en el registro de accesos.
- **SC-008**: Los enlaces de recuperación e invitación no pueden usarse una segunda vez ni después de su caducidad en el 100 % de las pruebas.
- **SC-009**: Tras retirar a una persona de recepción, su siguiente petición es rechazada en menos de 5 segundos.
- **SC-010**: Los correos de aviso de seguridad y de recuperación se entregan en más de 98 % de los envíos durante el piloto.
- **SC-011**: Al menos 90 % de los médicos y pacientes del piloto completan su registro al primer intento sin ayuda.

## Assumptions

- **Alcance**: esta feature cubre solo cuentas, acceso, consentimientos y auditoría; calendario, micrositio, reserva, urgencias, WhatsApp, cobro con Openpay y el panel de soporte completo quedan fuera. De soporte solo se incluye la vista mínima para revisar, aprobar, rechazar y liberar cédulas.
- **Piloto**: 3 a 5 médicos, cuentas activadas manualmente sin cobro; la cuenta de soporte inicial la crea el equipo de la plataforma fuera del flujo público.
- **Roles múltiples por correo**: un correo identifica a una sola cuenta con un solo rol (paciente, médico, recepción o soporte). Que una persona sea paciente y además médico o recepción queda fuera de la primera versión.
- **Verificación del móvil**: la verificación del móvil de emergencias por WhatsApp se activa en la fase con WhatsApp; en el piloto solo se valida el formato y la unicidad.
- **Textos legales**: se construyen con texto provisional; los textos finales (aviso de privacidad, términos, encargo de tratamiento, compromiso de confidencialidad) los redacta y revisa un abogado antes de que entre un paciente real (supuesto abierto 3 de `docs/decisions/0001-resumen-grill-me.md`).
- **Retención y borrado de datos**: los plazos de conservación y qué se borra al pedirlo el titular están sin definir (supuesto abierto 2); esta feature no implementa borrado, solo el canal para solicitar derechos.
- **Invitaciones pendientes**: cuentan hacia el límite de 2 personas de recepción (supuesto abierto 9, resuelto aquí por prudencia; puede revisarse).
- **Mayoría de edad**: el paso de un menor a cuenta propia no se contempla en esta versión.
- **Tiempo de inactividad**: el límite de sesión por inactividad se define en el plan; se asume un valor razonable (por ejemplo 30 minutos para soporte y médicos con datos de pacientes).
- **Idioma y zona horaria**: el producto opera en español y las fechas se muestran en la zona horaria del consultorio.
- **Dependencias**: envío de correo transaccional disponible para invitaciones, recuperación, avisos y notificación a soporte; la entrega confiable de correo es prerrequisito de varias historias.
- **Acciones de citas de recepción**: las acciones de recepción sobre citas (crear, cancelar) y la vista de agenda llegan con las features 2 y 3, que registrarán sus acciones en el mismo registro de acciones de recepción; en esta feature solo se prueban los permisos negativos y el acceso a datos de contacto de pacientes.
- **Derechos del titular**: el canal (por defecto `soporte@innvend.com`) y el plazo de respuesta (por defecto 20 días hábiles) son provisionales hasta la revisión legal.
- **Constitución**: la feature está sujeta a los principios I (privacidad), II (aislamiento por médico) y IV (seguridad) de `.specify/memory/constitution.md`.
