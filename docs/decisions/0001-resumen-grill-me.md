# 0001 · Resumen de decisiones del grill-me

Estado: confirmado por el usuario. Fecha: 2026-11-20.
Origen: entrevista `grill-me` previa a `/speckit-constitution` y `/speckit-specify`.

## Decisiones tomadas

### Producto y usuarios
- La plataforma es para médicos o consultorios dentales, que pagan la suscripción. El paciente reserva sin intermediarios. Las citas las crean el médico, la recepción o el paciente.
- Cada médico tiene un solo calendario, con ubicación y mapa de Google, teléfono del consultorio, logo opcional y bloqueo de espacios sueltos o rangos.
- Espacios de duración configurable (45 min por defecto) con intervalo configurable (15 min por defecto). Un paciente por espacio, sin doble reserva, y el espacio se libera al cancelar. Zona horaria del consultorio. Anticipación mínima y máxima configurables.
- El paciente cancela hasta 24 h antes (configurable). No hay reprogramación: cancela y reserva de nuevo. El médico cancela cuando quiera y se avisa al paciente por correo y, si lo tiene activo, por WhatsApp.

### Micrositio y acceso del paciente
- Un link por médico bajo un prefijo fijo (`/c/nombre`). El nombre es configurable al crearse, único, el primero que lo registra se queda con él, solo minúsculas, números y guiones. Sin regenerar; el cambio de nombre pasa por soporte. Sin lista de palabras reservadas (el prefijo evita choques con rutas de la app). Sin directorio, `noindex`, límite de peticiones por IP. Solo existe si el calendario está publicado.
- El micrositio muestra nombre, ubicación con mapa, teléfono del consultorio, logo opcional y opciones de reserva.
- Paciente: "Primera cita" o "Ya soy paciente". Correo registrado: pide contraseña (con recuperación por correo). Correo no registrado: pasa a Primera cita, que también pide contraseña. Se acepta que esto revele si un correo existe, mitigado con límite de peticiones.
- La cuenta del paciente es global, con aislamiento: cada médico ve solo a sus pacientes, y los datos se guardan por relación médico-paciente. Se pueden añadir pacientes adicionales (hijos) bajo la cuenta del tutor.
- Datos del paciente: nombre, fecha de nacimiento (no edad), correo, teléfono. Sin historial clínico. Consentimiento con aviso de privacidad, guardado con fecha y versión. El tutor consiente por los menores.
- Calendario tipo aerolínea: sin fechas pasadas; al elegir el día se muestran los horarios disponibles.

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
- "Sin doble reserva" se garantiza con una transacción que bloquea la fila del médico, revisa el solape e inserta, con un índice único (médico, hora de inicio) como respaldo y una prueba automática de reservas simultáneas. Horas guardadas en UTC.
- Tareas programadas por cron cada minuto (recordatorios, cola de mensajes con reintentos, fin de prueba, plazo de 72 h, borrado de la cola).
- Validación de toda entrada externa en runtime con zod.

### Alcance de la primera versión (piloto de 3 a 5 médicos)
- Registro y verificación del médico, calendario con espacios, bloqueos y urgencias, micrositio y flujo de reserva con cuenta de paciente, correos de confirmación y cancelación, recepción con invitación, y panel de soporte.
- Después del piloto: WhatsApp con cuotas por plan y cobro automático con Openpay. Durante el piloto las cuentas se activan manualmente sin cobro.
- Métricas del piloto: finalización de reserva (más de 70 %), tiempo para reservar (menos de 2 min), correos entregados (más de 98 %), urgencias con espacio frente a "llama al médico", citas por médico por semana, uso en la semana 4. Criterio de salida: al menos la mitad de los médicos del piloto la usa por su cuenta durante dos semanas seguidas.

## Fuera de alcance (por ahora)
- Reprogramación, historial clínico, duraciones por tipo de tratamiento, WhatsApp propio de cada médico, SMTP propio del médico, link con nombre editable por el médico, cobro por exceso de mensajes no urgentes, validación automática de la cédula y registro abierto.

## Supuestos abiertos
1. Precios de los planes, qué más distingue a Esencial, Profesional y Élite, y cuántos médicos tendrá el piloto.
2. Retención de datos: cuántos días se conservan tras un bloqueo largo, y qué se borra al pedirlo el titular.
3. Responsable de los datos y aviso de privacidad (LFPDPPP): decisión legal, requiere revisión de un abogado antes de abrir.
4. Hosting compartido: cron por minuto en lugar de un proceso permanente. Probar que los avisos de urgencia salen a tiempo y verificar la versión de MariaDB, los límites de envío del SMTP y la memoria de la app Node.
5. Openpay y cobros variables: el cobro de excedentes necesita un cargo aparte de la suscripción fija; confirmar con su documentación.
6. Plantillas de WhatsApp: aprobación de Meta y costo por mensaje real.
7. Contenido médico: las instrucciones de primeros auxilios del triaje y el aviso de acudir a un hospital deben ser validadas por un dentista.
8. Copias de seguridad, monitoreo y qué pasa si falla el cron: sin definir.
9. El límite de 2 invitaciones de recepción por médico: falta confirmar si cuentan las pendientes.
10. El recordatorio de 24 h y el límite de cancelación de 24 h coinciden en el mismo momento: decidir si el recordatorio sale antes.
11. Criterio de la cédula en disputa: hace falta una herramienta de administración para liberar una cédula registrada por error o por otra persona.
12. Reglas de triaje por categoría (ventanas de tiempo y alertas de "dificultad para tragar o respirar" o "hinchazón cerca del ojo"): la pregunta extra del flujo no está definida.
