# 0001 · Resumen de decisiones del grill-me

Estado: confirmado por el usuario. Fecha: 2026-11-20. Actualizado el 2026-11-22 (bloqueo de horarios y anticipación máxima por médico).
Origen: entrevista `grill-me` previa a `/speckit-constitution` y `/speckit-specify`.

## Decisiones tomadas

### Producto y usuarios
- La plataforma es para médicos o consultorios dentales, que pagan la suscripción. El paciente reserva sin intermediarios. Las citas las crean el médico, la recepción o el paciente.
- Cada médico tiene un solo calendario, con ubicación y mapa de Google, teléfono del consultorio, logo opcional y bloqueo de horarios (espacios sueltos o rangos).
- **Bloquear horarios solo es posible sobre horarios sin cita.** El médico no puede bloquear una cita existente: si el espacio o el rango incluye citas, el bloqueo se rechaza (indicando cuáles son) y el médico debe cancelar primero esas citas, con el aviso al paciente de siempre (ver «El médico cancela…»), y después bloquear. Esto vale para el médico y para su recepción.
- Espacios de duración configurable (45 min por defecto) con intervalo configurable (15 min por defecto). Un paciente por espacio, sin doble reserva, y el espacio se libera al cancelar. Zona horaria del consultorio.
- **Anticipación de reserva configurable por médico:** la anticipación mínima y la máxima (cuántos días hacia adelante puede reservar un paciente) las define cada médico para su propio calendario, y el servidor las comprueba en cada reserva. El valor por defecto y los límites permitidos se definen en la spec del calendario (supuesto abierto 12).
- El paciente cancela hasta 24 h antes (configurable). No hay reprogramación: cancela y reserva de nuevo. El médico cancela cuando quiera y se avisa al paciente por correo y, si lo tiene activo, por WhatsApp.

### Micrositio y acceso del paciente
- Un link por médico bajo un prefijo fijo (`/c/nombre`). El nombre es configurable al crearse, único, el primero que lo registra se queda con él, solo minúsculas, números y guiones. Sin regenerar; el cambio de nombre pasa por soporte. Sin lista de palabras reservadas (el prefijo evita choques con rutas de la app). Sin directorio, `noindex`, límite de peticiones por IP. Solo existe si el calendario está publicado.
- El micrositio muestra nombre, ubicación con mapa, teléfono del consultorio, logo opcional y opciones de reserva.
- Paciente: "Primera cita" o "Ya soy paciente". Correo registrado: pide contraseña (con recuperación por correo). Correo no registrado: pasa a Primera cita, que también pide contraseña. Se acepta que esto revele si un correo existe, mitigado con límite de peticiones.
- La cuenta del paciente es global, con aislamiento: cada médico ve solo a sus pacientes, y los datos se guardan por relación médico-paciente. Se pueden añadir pacientes adicionales (hijos) bajo la cuenta del tutor.
- Datos del paciente: nombre, fecha de nacimiento (no edad), correo, teléfono. Sin historial clínico. Consentimiento con aviso de privacidad, guardado con fecha y versión. El tutor consiente por los menores.
- Calendario tipo aerolínea: sin fechas pasadas; al elegir el día se muestran los horarios disponibles.

### Mensajes de cita al paciente
- La cita queda agendada al reservar; el paciente no tiene que confirmarla. El correo de confirmación es informativo (fecha, hora, consultorio, ubicación) y lleva un enlace para ver o cancelar la cita.
- El recordatorio sale unas 30 h antes de la cita (antes del límite de cancelación de 24 h) y lleva un enlace para cancelar. No hay botón de "confirmar asistencia" en la primera versión, y no hay cancelación automática si el paciente no responde.
- Los enlaces llevan un token firmado, de un solo uso y con caducidad, ligado a la cita. Abrir el enlace nunca cambia el estado: muestra el resumen y un botón, y el cambio ocurre al pulsarlo (con protección CSRF), porque los antivirus y clientes de correo abren los enlaces automáticamente.
- Cancelar desde el enlace exige sesión iniciada y respeta el límite de cancelación (las urgencias están exentas).
- Después del piloto, con WhatsApp: respuestas rápidas ("Confirmo" y "Cancelar") por webhook con verificación de firma de Meta.

### Urgencias
- Los horarios de urgencia no aparecen en el calendario y son solo para urgencias. Una urgencia también puede usar horarios convencionales.
- El triaje (5 opciones con semáforo) asigna el espacio más próximo según el nivel. El paciente no ve calendario en una urgencia.
- Sin espacio dentro de la ventana: se muestra que no se encontró espacio y el móvil de emergencias del médico. Con espacio: se agenda y se confirma por correo.
- El triaje no se guarda. Solo se guarda el tipo de cita (urgencia o convencional); la agenda lo muestra con una etiqueta.
- El aviso de urgencia al médico lleva categoría (lista fija de 5), día y hora, sin nombre del paciente. La categoría vive solo en la cola de envío y se borra al entregarse, o a las 24 h como máximo. Si el envío falla, el médico recibe un aviso genérico sin categoría.
- Las urgencias tienen su propia anticipación mínima (30 min por defecto, configurable), están exentas del límite de cancelación de 24 h y llevan protecciones contra abuso: máximo una urgencia activa por paciente, máximo 3 solicitudes por cuenta cada 24 h, CAPTCHA en el paso de urgencia, y cancelación de urgencia avisada al médico por correo.
- Los registros técnicos, métricas y herramientas de errores nunca incluyen la categoría ni el contenido de los mensajes.

### Datos visibles para el médico y la recepción
- En la agenda (con inicio de sesión): nombre, teléfono, correo y edad calculada del paciente; si es menor, también el tutor. Solo pacientes de ese médico.
- Correo de cita convencional al médico: nombre, fecha, hora y etiqueta de tipo. WhatsApp al médico: sin nombre.
- Cada acceso al detalle de un paciente queda registrado (quién y cuándo, sin contenido).

### Médicos, recepción y verificación
- Registro con cédula profesional y móvil de emergencias. El móvil debe ser móvil, único por cuenta y verificado por WhatsApp. El teléfono del consultorio es aparte, puede ser fijo y no se verifica.
- Aprobación manual de la cédula. Soporte recibe un correo de aviso a `soporte@innvend.com`, sin adjuntos y con enlace al panel. El médico no tiene acceso hasta que se aprueba, y los 5 días de prueba empiezan al aprobar. Una cédula no puede estar en dos cuentas.
- Dónde se muestra cada número: micrositio y médico bloqueado, teléfono del consultorio; urgencia sin espacio, móvil de emergencias; correos de confirmación, teléfono del consultorio.
- Recepción: hasta 2 personas por médico, invitadas por correo con enlace de un solo uso que caduca (por ejemplo, 7 días). Pueden ver la agenda y crear o cancelar citas, y ver los datos de contacto del paciente. No cambian configuración, pagos, móvil de emergencias ni cédula, y no invitan a otros. Quitar la invitación corta el acceso al instante. Una persona puede trabajar con varios médicos. Cada acción registra quién la hizo.
- Seguridad de cuentas: contraseña de mínimo 10 caracteres, sin reglas de composición, rechazo de contraseñas comunes o filtradas, hash con argon2id o bcrypt. Límite de intentos con espera creciente. Recuperación con enlace de un solo uso de 30 min y respuesta uniforme. Sesiones con cookies `HttpOnly`, `Secure` y `SameSite`, y caducidad por inactividad. Doble factor obligatorio para soporte y opcional para médicos y recepción. Aviso por correo ante cambios de contraseña o dispositivo nuevo. Los cambios sensibles piden la contraseña de nuevo.

### Planes y cobro
- Esencial (con prueba de 5 días; correo y 30 avisos de urgencia por WhatsApp al mes), Profesional (400 mensajes al mes) y Élite (1,200). Los planes Profesional y Élite no tienen prueba.
- Mensajes de WhatsApp contados: recordatorio de 24 h, cancelación médico→paciente, cancelación paciente→médico, aviso de urgencia al médico y confirmación paciente→médico. Al agotar la cuota los mensajes pasan a correo, con aviso al 80 %. El contador sigue el ciclo de facturación y no acumula.
- Los avisos de urgencia nunca se bloquean: el exceso se cobra a 1 peso por mensaje en la siguiente suscripción, con tope de 100 por ciclo, y luego pasan a correo.
- Cobro con Openpay. Al terminar la prueba, se avisa por correo y hay 72 h de plazo. Después el médico ve su calendario en solo lectura, el link no acepta reservas con el mensaje de confirmar directamente con el consultorio por teléfono, y los pacientes con citas existentes reciben un aviso para confirmar directamente con el médico. Los datos no se borran.
- WhatsApp sale solo de la cuenta Business de la plataforma, no de la de cada médico. El paciente acepta recibirlo con una casilla aparte del consentimiento de privacidad.

### Técnica
- Node.js y TypeScript. Despliegue en Hostinger Business Web Hosting, en `agendadental.innvend.com`. Base de datos MariaDB (InnoDB). Correo por SMTP de Hostinger: todo sale de la plataforma, con el médico como `Reply-To`, y SPF, DKIM y DMARC configurados. Proveedor transaccional como respaldo. Google Maps para la ubicación, con tope de gasto.
- "Sin doble reserva" se garantiza con una transacción que bloquea la fila del médico, revisa el solape e inserta, con un índice único (médico, hora de inicio) como respaldo y una prueba automática de reservas simultáneas. Horas guardadas en UTC. El bloqueo de horarios usa la misma transacción (bloquea la fila del médico, comprueba que no haya citas ni solapes y luego inserta), para que una reserva simultánea no pueda colarse en un horario que se está bloqueando; también lleva su prueba de concurrencia.
- Tareas programadas por cron cada minuto (recordatorios, cola de mensajes con reintentos, fin de prueba, plazo de 72 h, borrado de la cola).
- Validación de toda entrada externa en runtime con zod.

### Aviso de privacidad y consentimiento (requisito de la primera versión)
- Desde el piloto hay aviso de privacidad. Ningún paciente real entra sin los textos revisados por un abogado, tampoco en el piloto. La construcción (casillas, registro, versionado) puede hacerse antes con texto provisional.
- Quién acepta qué:
  - Paciente: aviso de privacidad, con consentimiento expreso por los datos de salud, al crear la cuenta (casilla sin marcar de antemano).
  - Tutor: el mismo aviso, en nombre del menor, al añadir un paciente adicional.
  - Médico: aviso de privacidad propio (cédula y su foto, móvil de emergencias, domicilio, datos de cobro) y términos y condiciones del servicio, al registrarse y antes de subir la cédula.
  - Recepción: aviso de privacidad propio y compromiso de confidencialidad, al aceptar la invitación.
  - Paciente, WhatsApp: consentimiento aparte, con casilla separada (fases con WhatsApp).
- Responsable de los datos: el médico decide sobre los datos de sus pacientes y la plataforma los trata por él (cláusula de encargo de tratamiento en los términos con el médico). La cuenta global del paciente (correo y contraseña) la decide la plataforma.
- El aviso debe cubrir: identidad y domicilio del responsable, datos recabados (con los sensibles señalados), finalidades necesarias y opcionales, terceros que reciben datos (Hostinger, Google, Meta, el proveedor de cobro, algunos fuera de México), cómo ejercer los derechos de acceso, rectificación, cancelación y oposición, y cómo se avisa de cambios.
- A construir en la primera versión:
  1. Casillas de aceptación sin marcar de antemano, que bloquean el registro.
  2. Registro de cada aceptación: quién, qué documento, qué versión y cuándo.
  3. Versionado de los textos, con nueva aceptación cuando cambian.
  4. Aviso accesible siempre, desde el registro y desde el pie del micrositio.
  5. Procedimiento de derechos del titular, con un canal real y un plazo de respuesta definido.

### Alcance de la primera versión (piloto de 3 a 5 médicos)
- Registro y verificación del médico, calendario con espacios, bloqueos y urgencias, micrositio y flujo de reserva con cuenta de paciente, correos de confirmación y cancelación, recepción con invitación, y panel de soporte.
- Después del piloto: WhatsApp con cuotas por plan y cobro automático con Openpay. Durante el piloto las cuentas se activan manualmente sin cobro.
- Métricas del piloto: finalización de reserva (más de 70 %), tiempo para reservar (menos de 2 min), correos entregados (más de 98 %), urgencias con espacio frente a "llama al médico", citas por médico por semana, uso en la semana 4. Criterio de salida: al menos la mitad de los médicos del piloto la usa por su cuenta durante dos semanas seguidas.

## Fuera de alcance (por ahora)
- Reprogramación, historial clínico, duraciones por tipo de tratamiento, WhatsApp propio de cada médico, SMTP propio del médico, link con nombre editable por el médico, cobro por exceso de mensajes no urgentes, validación automática de la cédula y registro abierto.

## Supuestos abiertos
1. Precios de los planes, qué más distingue a Esencial, Profesional y Élite, y cuántos médicos tendrá el piloto.
2. Retención de datos: cuántos días se conservan tras un bloqueo largo, y qué se borra al pedirlo el titular.
3. Texto legal del aviso de privacidad, de los términos y condiciones y de la cláusula de encargo de tratamiento (LFPDPPP): lo redacta y revisa un abogado antes de que entre un paciente real. Se debe verificar con él la normativa vigente y la autoridad competente.
4. Hosting compartido: cron por minuto en lugar de un proceso permanente. Probar que los avisos de urgencia salen a tiempo y verificar la versión de MariaDB, los límites de envío del SMTP y la memoria de la app Node.
5. Openpay y cobros variables: el cobro de excedentes necesita un cargo aparte de la suscripción fija; confirmar con su documentación.
6. Plantillas de WhatsApp: aprobación de Meta y costo por mensaje real.
7. Contenido médico: las instrucciones de primeros auxilios del triaje y el aviso de acudir a un hospital deben ser validadas por un dentista.
8. Copias de seguridad, monitoreo y qué pasa si falla el cron: sin definir.
9. El límite de 2 invitaciones de recepción por médico: falta confirmar si cuentan las pendientes.
10. ~~Criterio de la cédula en disputa~~ — **RESUELTO el 2026-11-24** en el panel de soporte (`specs/005-panel-de-soporte/`, [0006](0006-panel-soporte.md)): soporte libera la cédula y el móvil con motivo y confirmación, viendo antes cuántas citas futuras tiene la cuenta y el estado de su micrositio; el médico recibe un aviso fijo y la cédula puede registrarla otra persona.
11. Reglas de triaje por categoría (ventanas de tiempo y alertas de "dificultad para tragar o respirar" o "hinchazón cerca del ojo"): la pregunta extra del flujo no está definida.
12. ~~Anticipación de reserva por médico~~ — **RESUELTO el 2026-11-22** en la spec del calendario (`specs/002-calendario-del-medico/spec.md`) y en [0003](0003-calendario.md): anticipación mínima por defecto 2 horas (de 0 horas a 7 días) y máxima por defecto 60 días (de 1 a 365 días), siempre con mínima menor que máxima y configurables por médico; si el médico reduce la máxima, las citas ya agendadas **se conservan** (el límite solo afecta a reservas nuevas); y al bloquear un horario con citas, el bloqueo se **rechaza por completo** y se muestra la lista de citas en conflicto (fecha, hora y nombre del paciente; hasta 50 y el total) para cancelarlas primero.
