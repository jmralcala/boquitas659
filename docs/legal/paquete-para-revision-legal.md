# Paquete para revisión legal: Agenda Dental

**Plataforma**: Agenda Dental (agendadental.innvend.com), agenda en línea para consultorios dentales. Piloto cerrado de 3 a 5 médicos.
**Fecha del paquete**: 26/11/2026.
**Destinatario**: abogado o despacho que redactará y revisará los textos legales.
**Cómo usar este documento**: reúne **todos los textos del producto que tienen efecto legal**, tal como están hoy, y los datos que el producto trata, para que usted pueda redactar los documentos definitivos y revisar los demás. Los textos entre comillas son **literales** del producto.

---

## 1. Resumen y estado actual

1. **Los cinco documentos legales hoy son solo un marcador de posición.** No existe un texto redactado: cada uno dice únicamente «TEXTO PROVISIONAL. Este documento es un marcador de posición y no ha sido revisado por un abogado. No debe usarse con pacientes reales ni con datos reales hasta sustituirse por la versión revisada.» seguido de su título. **Hay que redactarlos** (sección 2).
2. **Qué está bloqueado mientras sean provisionales** (decisión del proyecto: ningún paciente real entra sin textos revisados por un abogado):
   - El **registro de médicos en producción**: al enviar el formulario aparece «El registro todavía no está disponible: estamos terminando la revisión legal de nuestros avisos. Inténtalo de nuevo más adelante.»
   - La entrada de **pacientes reales** y de personal de recepción (los textos provisionales no pueden mostrarse a personas reales).
3. Además de los cinco documentos, hay **textos con efecto legal dentro de las pantallas** (casillas de consentimiento, autorización, aviso de derechos, avisos de urgencia, mensajes de la portada). Están en las secciones 3 a 6 y también deben revisarse, porque se publican junto con los documentos.
4. **Datos de identificación del responsable** (razón social, domicilio, medio de contacto oficial del titular): **por confirmar por la empresa**; este paquete no los inventa. En este documento no se incluyen RFC, CURP, cuentas bancarias ni contraseñas.

---

## 2. Documentos a redactar (los que se publican en `/legal`)

Cada documento tiene versión; al publicar una versión nueva, **cada persona debe aceptarla de nuevo** la próxima vez que entre (pantalla «Actualizamos nuestros avisos»). Se publican con el procedimiento de la sección 8.

| # | Clave | Título actual | Quién lo acepta | Cuándo | Dirección pública |
|---|---|---|---|---|---|
| 1 | `patient_privacy` | Aviso de privacidad para pacientes | Paciente (y tutor en nombre de un menor) | Al crear la cuenta de paciente, al añadir a un menor, y cuando se publique una versión nueva | `/legal/patient_privacy` |
| 2 | `doctor_privacy` | Aviso de privacidad para médicos | Médico | Al registrarse y ante versiones nuevas | `/legal/doctor_privacy` |
| 3 | `terms_doctor` | Términos y condiciones del servicio para médicos | Médico | Al registrarse y ante versiones nuevas | `/legal/terms_doctor` |
| 4 | `reception_privacy` | Aviso de privacidad para personal de recepción | Persona de recepción | Al aceptar la invitación de un médico | `/legal/reception_privacy` |
| 5 | `reception_confidentiality` | Compromiso de confidencialidad de recepción | Persona de recepción | Al aceptar la invitación de un médico | `/legal/reception_confidentiality` |

Los textos se muestran como párrafos de texto simple (separados por líneas en blanco), sin formato; los enlaces y las tablas no se admiten.

### Puntos que el producto necesita que cada documento cubra (propuesta para su criterio)

- **Aviso de privacidad para pacientes (1)**: identidad y domicilio del responsable y del encargado (ver pregunta A1); datos recabados (sección 5), **incluidos datos de salud** (la cita es con un consultorio dental; las urgencias implican una categoría de gravedad que se elimina a las 24 h como máximo); finalidades primarias (reservar, cancelar y atender citas, enviar confirmaciones y recordatorios por correo) y secundarias, si las hay; transferencias y encargados (sección 5.4); mecanismo para ejercer derechos ARCO y para **revocar** el consentimiento (sección 6); uso de cookies y de medios de seguridad; cambios al aviso; autoridad competente y fecha de la última actualización.
- **Aviso de privacidad para médicos (2)** y **recepción (4)**: datos de cuenta, cédula profesional (número y copia del archivo), móvil de emergencias, datos del consultorio; quién los ve (soporte aprueba cédulas); finalidades; derechos.
- **Términos y condiciones para médicos (3)**: objeto del servicio; prueba y activación manual durante el piloto (sin cobro); obligaciones del médico (veracidad de cédula y datos, uso correcto de la agenda y del micrositio, confidencialidad de los datos de sus pacientes); **la plataforma no presta servicios médicos ni sustituye la valoración de un profesional**; suspensión, solo lectura y bloqueo de cuentas por soporte; disponibilidad del servicio; limitación de responsabilidad; propiedad intelectual; modificación de los términos; ley aplicable y jurisdicción. **Aquí suele ubicarse la cláusula de encargo de tratamiento** (ver pregunta A2).
- **Compromiso de confidencialidad de recepción (5)**: deber de guardar la confidencialidad de los datos de los pacientes, alcance, duración y consecuencias.

---

## 3. Consentimientos y autorizaciones dentro de las pantallas (literales)

### 3.1 Alta de paciente («Primera cita» y registro de paciente)
- Casilla (sin marcar de antemano, bloquea el avance): «He leído y acepto el **Aviso de Privacidad para Pacientes** y otorgo mi **consentimiento expreso** para el tratamiento de mis datos personales y de salud con la finalidad exclusiva de gestionar mis citas odontológicas.» (el enlace abre `patient_privacy` en una pestaña nueva).
- Mensaje si no se marca: «Debes aceptar el aviso de privacidad y otorgar tu consentimiento expreso para poder continuar con el agendamiento.»

### 3.2 Alta de un menor (paciente adicional) por su tutor
- Casilla: «Declaro bajo protesta de decir verdad que ejerzo la patria potestad o tutela legal del menor registrado, acepto en su representación el **Aviso de Privacidad para Pacientes** y otorgo el **consentimiento expreso** para el tratamiento de sus datos personales y de salud para la gestión de sus citas odontológicas.»
- Mensaje si no se marca: «Debes aceptar el aviso de privacidad en nombre del menor para continuar.»

### 3.3 Autorización para que el consultorio vea los datos de contacto (al reservar y en el formulario de urgencia)
- Casilla (sin marcar): «Autorizo a **{nombre del médico}** y a su personal de recepción debidamente autorizado a consultar el nombre y datos de contacto (teléfono y correo electrónico) vinculados a mi cuenta, exclusivamente para la programación, confirmación y seguimiento de mis citas. Reconozco que puedo revocar este acceso en cualquier momento desde la sección «Mis consultorios» de mi cuenta.»
- Cada autorización queda registrada (quién, qué documento y versión, cuándo).
- Ajuste respecto del texto sugerido: «configuración de mi perfil» se cambió por «Mis consultorios», que es donde existe hoy la revocación.

### 3.4 Pantalla «Mis consultorios» y revocación (paciente)
- «Estos consultorios pueden ver el nombre y los datos de contacto (correo y teléfono) de los pacientes de tu cuenta para atender tus citas.»
- Al revocar el vínculo con un consultorio, el paciente ve:
  - «No tienes citas futuras con este consultorio.» / «Se cancelará 1 cita futura con este consultorio (el consultorio recibirá el aviso).» / «Se cancelarán N citas futuras con este consultorio (el consultorio recibirá el aviso).»
  - «El consultorio dejará de ver los datos de contacto (correo y teléfono) de las personas de tu cuenta.»
  - «Conservará el nombre en las citas que ya pasaron.»
  - «Podrás volver a reservar con este consultorio cuando quieras; se te pedirá autorizar de nuevo.»

### 3.5 Registro de médicos
- Introducción: «Tu cuenta quedará en revisión hasta que soporte valide tu cédula profesional.»
- Casilla 1 (términos): «He leído y acepto los **Términos y Condiciones del Servicio para Médicos**, reconociendo y aceptando que la plataforma opera exclusivamente como una herramienta tecnológica de gestión de agenda y no presta servicios médicos ni odontológicos.»
- Casilla 2 (privacidad): «He leído y acepto el **Aviso de Privacidad para Médicos** y autorizo la validación de mi cédula profesional, identificación oficial, acreditación académica e información de consultorio por parte del equipo de soporte.» Mensaje si falta: «Debes aceptar el aviso de privacidad para continuar.»
- Campos que se piden: nombre completo, correo, contraseña, cédula profesional, móvil de emergencias (10 dígitos), teléfono del consultorio (opcional) foto o PDF de la cédula y foto o PDF de una identificación oficial (máx. 5 MB cada uno). Cada archivo lleva un ícono de información con el motivo: se piden para evitar la usurpación de identidad y proteger al paciente; soporte coteja la identificación con la cédula a mano. **A verificar con usted**: conservación y borrado de la identificación (hoy se conserva mientras exista la cuenta) y su mención expresa en el Aviso de Privacidad para Médicos.

### 3.6 Invitación a recepción
- «{médico} te invitó a colaborar como personal de recepción con el correo {correo}.»
- Casilla 1: «He leído y acepto el **Aviso de Privacidad para Personal de Recepción**.»
- Casilla 2: «He leído y acepto el **Compromiso de Confidencialidad**, obligándome a guardar estricto secreto profesional respecto de toda información, datos de contacto y registros de agenda a los que tenga acceso en el ejercicio de mis funciones.»
- Mensajes: «Debes aceptar el aviso de privacidad para continuar.» / «Debes aceptar el compromiso de confidencialidad para continuar.»

### 3.7 Aceptación de una versión nueva (cualquier rol)
- «Actualizamos nuestros avisos» / «Para seguir usando el servicio debes aceptar la versión vigente de estos documentos.» / casilla por documento: «He leído y acepto {título} (versión N)». Mensaje si falta alguna: «Debes aceptar todos los avisos para continuar: marca la casilla de cada documento.»

### 3.8 Documento provisional visible
- Mientras un documento sea provisional se muestra: «Este texto es provisional y todavía no ha sido revisado por un abogado.»

---

## 4. Aviso de derechos sobre los datos (`/derechos`, literal)

> **Derechos ARCO, revocación y limitación del tratamiento**
> Como titular de datos personales (o representante legal de un menor registrado), usted tiene derecho a conocer qué datos recabamos y las condiciones de su uso (**Acceso**); solicitar la corrección de su información en caso de estar desactualizada, ser inexacta o incompleta (**Rectificación**); pedir que sea eliminada de nuestras bases de datos cuando considere que no está siendo utilizada conforme a los principios legales aplicables (**Cancelación**); y oponerse al tratamiento de sus datos para finalidades específicas (**Oposición**).
> Asimismo, tiene derecho a **revocar el consentimiento** que nos haya otorgado previamente para el tratamiento de su información y a **limitar el uso o divulgación** de sus datos personales.
>
> **Requisitos para la solicitud** — envíe un correo a **{correo público de contacto}**, adjuntando: (1) nombre completo del titular y correo vinculado a la cuenta; (2) copia de una identificación oficial vigente (si actúa en representación de un menor o tercero, el documento que acredite la patria potestad o representación legal); (3) descripción clara del derecho que desea ejercer (Acceso, Rectificación, Cancelación, Oposición, Revocación o Limitación) y de los datos sobre los que recae; (4) en caso de rectificación, las modificaciones precisas y la documentación que las justifique.
>
> **Plazos de respuesta** — recibida la solicitud completa, respuesta en un plazo máximo de **{20} días hábiles** al correo registrado, y, en su caso, ejecución dentro de los **{15} días hábiles** siguientes a la notificación.

- Correo público configurado hoy: `soporte@innvend.com` (buzón por confirmar como oficial para derechos). Plazos configurados hoy: 20 días hábiles de respuesta (`RIGHTS_RESPONSE_DAYS`) y 15 de ejecución (`RIGHTS_EXECUTION_DAYS`), ambos configurables.
- **A verificar con usted**: si el texto y los plazos corresponden a la normativa vigente (incluida la reciente reforma en la materia y la autoridad competente actual) y si es procedente **exigir copia de identificación oficial** por correo (implica tratar un dato más; valore alternativas, p. ej. validar desde la cuenta).
- Este texto está enlazado desde el pie de todas las pantallas («Tus derechos sobre tus datos») junto con «Aviso de privacidad y términos».

---

## 5. Datos que trata la plataforma (para redactar los avisos)

### 5.1 Datos por tipo de persona

| Persona | Datos |
|---|---|
| **Paciente** | Nombre completo, fecha de nacimiento, correo, teléfono (10 dígitos), contraseña (se guarda cifrada, nunca en claro). Las **citas** (con qué consultorio, fecha y hora, si es regular o de **urgencia**, si está agendada o cancelada, quién la creó o canceló). Aceptaciones del aviso (qué documento, versión y cuándo). La autorización para que cada consultorio vea sus datos de contacto. |
| **Menor** (dependiente de un paciente) | Nombre completo, fecha de nacimiento, teléfono opcional; lo administra su tutor, que acepta en su nombre. |
| **Médico** | Nombre, correo, contraseña (cifrada), número de **cédula profesional** y copia del archivo (imagen o PDF, guardada en un directorio privado del servidor), móvil de emergencias, teléfono y dirección del consultorio, logotipo opcional, nombre del enlace público (micrositio), horarios y bloqueos de su agenda, aceptaciones. |
| **Personal de recepción** | Nombre, correo, contraseña (cifrada), aceptaciones, y a qué médicos está vinculado. |
| **Soporte (plataforma)** | Cuenta con doble factor obligatorio; sus acciones quedan en un registro de solo anexar (quién, qué, cuándo, motivo). Soporte **no ve datos de pacientes**. |

### 5.2 Datos de salud y sensibles
- La plataforma **no guarda historial clínico, diagnósticos ni el resultado del triaje**: solo el tipo de cita (urgencia o convencional).
- En una **urgencia**, el paciente elige una categoría de gravedad (cinco niveles de color) y puede marcar señales de alarma. **La categoría no se guarda** en la cita: solo existe en la cola de envío del aviso al médico y se **elimina al entregarse o a las 24 horas como máximo**; si el envío falla, el médico recibe un aviso genérico sin categoría.
- Los registros técnicos, métricas y herramientas de errores **no contienen** datos personales, categoría de urgencia ni contenido de mensajes.

### 5.3 Quién ve qué
- **El consultorio** (médico y su recepción) ve el nombre y los datos de contacto de los pacientes **que autorizaron** a ese consultorio, y sus citas con él. Cada acceso al detalle de un paciente queda registrado (quién y cuándo, sin contenido).
- **Otros consultorios** no ven los datos de los pacientes de un consultorio ajeno (aislamiento por médico).
- **El paciente** ve sus citas con cualquier consultorio y puede revocar a cada uno.
- **Soporte** ve estado de cuentas de médicos, la copia de la cédula (para validarla) y métricas agregadas; **nunca** datos de pacientes ni el contenido de correos.

### 5.4 Encargados, proveedores y transferencias (a confirmar por la empresa)
- **Hosting, base de datos y correo**: Hostinger (servidor compartido, base MariaDB y buzón de correo saliente `agenda@innvend.com`). Los registros técnicos del servidor muestran un nombre de equipo de la región de Phoenix, EE. UU. (`us-phx-web1200`), por lo que **conviene confirmar el país donde se alojan los datos** (posible **transferencia o remisión internacional**).
- **Protección contra abuso en el formulario de urgencia**: Cloudflare Turnstile. Al cargar ese formulario, el navegador de la persona se comunica con Cloudflare (por ejemplo, su dirección IP y datos del navegador). Es el **único recurso de terceros** del sitio y solo aparece en esa pantalla.
- **Mapa**: la dirección del consultorio se muestra con un enlace «Cómo llegar» a Google Maps; **no se incrusta** nada de Google y no se envía ningún dato a Google salvo que la persona pulse el enlace.
- **Analítica y publicidad**: ninguna. El sitio no usa herramientas de seguimiento.
- **Cookies**: de sesión (inicio de sesión), de dispositivo de confianza (seguridad del acceso) y de protección contra falsificación de formularios; todas propias y necesarias. La portada no establece cookies.

### 5.5 Conservación (lo que existe hoy y lo que falta definir)
- Categoría de urgencia en la cola: se elimina al entregarse o a las **24 horas como máximo**.
- Registro de acciones del calendario: **90 días**.
- Correos entregados y fallidos en la cola de envío: **30 días**.
- Nombre del enlace de un micrositio que cambia: queda **reservado 90 días** para su dueño.
- Citas canceladas: **se conservan**.
- Cuenta de un médico bloqueada o suspendida: **los datos se conservan**; no hay borrado automático. Solo se borran a solicitud del titular.
- **Sin definir todavía (requiere su criterio)**: plazo de conservación de los datos de pacientes, médicos y recepción tras el fin de la relación; qué se borra y qué se bloquea cuando el titular ejerce su derecho de cancelación; copias de seguridad.

### 5.6 Medidas de seguridad (resumen)
Contraseñas con algoritmo de cifrado de un solo sentido y rechazo de contraseñas comunes; doble factor opcional para médicos y obligatorio para soporte; límites de intentos de acceso; cookies seguras; protección contra falsificación de formularios; separación de datos por consultorio; registro de accesos a datos de pacientes y de acciones de soporte; archivos de cédula fuera de la carpeta pública del servidor; direcciones IP guardadas solo en forma de huella (no en claro) para los límites de intentos.

---

## 6. Ejercicio de derechos hoy

- **Acceso, rectificación, cancelación y oposición**: por correo al buzón público de contacto, con respuesta en 20 días hábiles y ejecución en 15 más (texto de la sección 4). **No hay todavía un formulario ni un procedimiento interno documentado** para atender cada solicitud.
- **Revocación de la autorización a un consultorio**: la hace el propio paciente desde «Mis consultorios» (sección 3.4); cancela sus citas futuras con ese consultorio y el consultorio deja de ver sus datos de contacto.
- **Borrado de datos a petición del titular**: **sin definir** (ver 5.5); hoy lo haría un administrador a mano.

---

## 7. Textos de urgencia, de la portada y otros mensajes con riesgo legal

### 7.1 Formulario y avisos de urgencia (contenido provisional que además valida un dentista)
- Introducción: «Responde estas preguntas y te asignaremos el espacio más próximo con el consultorio. No tendrás que elegir fecha ni hora.»
- Deslinde (se muestra en el formulario): «**Aviso de deslinde de responsabilidad médica y asistencial:** Este asistente de agenda de urgencias es una herramienta tecnológica orientativa para la asignación y priorización de horarios de consulta presencial. En ningún caso constituye un diagnóstico clínico, triaje médico definitivo ni sustituto del examen directo por parte de un profesional de la salud dental. Si experimenta dolor incontrolable o malestar severo, acuda de inmediato a un centro de salud.» Además: «Contenido provisional (versión …).»
- Aviso de emergencia (cuando no hay espacio en los niveles altos **y** cuando se marca una señal de alarma): «**ATENCIÓN - RIESGO DE EMERGENCIA MÉDICA:** Si usted o el paciente presenta alguna de las siguientes condiciones: sangrado continuo o abundante que no se detiene tras aplicar presión directa; inflamación de rápido avance que compromete el ojo, el cuello o el piso de la boca; dificultad para respirar, hablar o deglutir (tragar); traumatismo con pérdida de consciencia o desorientación. **No espere una cita dental. Diríjase de inmediato al servicio de urgencias hospitalarias más cercano o comuníquese a la línea de emergencias médicas de su localidad (911).**»
- Señales de alarma (casillas): «Tengo dificultad para tragar o para respirar» y «Tengo hinchazón cerca del ojo».
- Recomendaciones mientras acude a su consulta: (a) **Diente expulsado por golpe (avulsión dental)**: sujetarlo solo por la corona blanca, sin frotar la raíz, conservarlo en leche pasteurizada o solución salina estéril y llevarlo al consultorio; (b) **Control de hemorragia**: gasa limpia y seca, presión firme y continua al menos 10 a 15 minutos; (c) **Manejo del dolor e inflamación**: compresas frías en la mejilla, sin calor ni tabletas de analgésico sobre la encía o la mucosa.
- Las cinco categorías (Rojo, Naranja, Amarillo, Verde claro, Verde) y su ventana máxima de espera (2, 12, 24, 48 y 72 horas) están en `src/modules/urgent/triage-content.ts`.
- **Para usted**: el contenido clínico lo valida un dentista; a usted le corresponde el **deslinde de responsabilidad** y la redacción del aviso de emergencia (ya incorporados en esta versión provisional). Las urgencias en línea no se ofrecen en producción hasta esa validación.

### 7.2 Portada pública (afirmaciones publicitarias)
La portada afirma únicamente: que los pacientes pueden reservar y cancelar citas en línea desde el celular y recibir avisos y recordatorios por correo; que la agenda se configura (horarios, duración, pausa, bloqueos); que no hay dobles reservas; que los datos de un consultorio están separados de los de otros; y que «Revisamos cada solicitud antes de activar la cuenta». **No** promete reprogramación, mensajería distinta del correo, precios, rentabilidad ni resultados. Enlaza el aviso de privacidad de médicos, los términos y un correo de contacto.

### 7.3 Mensajes al médico y a pacientes por correo
La plataforma envía correos transaccionales (confirmación, recordatorio y cancelación de citas, aviso de nueva solicitud a soporte, aprobación, rechazo, suspensión, solo lectura, reactivación, cambio de enlace, recuperación de contraseña y avisos de seguridad). Si usted lo requiere, se le entrega el texto íntegro de cada plantilla; sus textos de estado de cuenta son fijos y **no revelan el motivo interno** de la decisión de soporte.

---

## 8. Cómo se publican los textos revisados

1. Usted entrega cada documento como **archivo de texto** (párrafos separados por una línea en blanco).
2. El equipo técnico lo publica con: `npm run legal:publish -- --type <clave> --file <archivo> --title "<título>" --reviewed` (la opción `--reviewed` lo marca como revisado; sin ella queda provisional y sigue bloqueando el registro).
3. Cada publicación crea una versión nueva (las anteriores se conservan) y todas las personas con cuenta deberán aceptarla de nuevo la próxima vez que entren.
4. Se repite para los cinco documentos y se comprueba en `/legal` que ninguno diga «provisional». Con eso se abre el registro de médicos y puede entrar el primer paciente real.

---

## 9. Preguntas abiertas para el abogado

- **A1. Roles**: ¿quién es el **responsable** del tratamiento de los datos de los pacientes (el consultorio/médico) y quién el **encargado** (la plataforma)? ¿O la plataforma es responsable de ciertos datos (cuentas, seguridad)? Define quién firma cada aviso y a quién se dirigen los derechos.
- **A2. Encargo de tratamiento**: la constitución del proyecto menciona una «cláusula de encargo de tratamiento». Hoy **no existe un documento aparte** para ello: ¿va dentro de los términos para médicos (propuesta) o se requiere un documento independiente (que habría que añadir al producto)?
- **A3. Consentimiento de datos sensibles**: ¿es suficiente la casilla de consentimiento expreso con enlace al aviso (sección 3.1), o debe ser por escrito u otra forma? ¿Debe separarse el consentimiento de finalidades secundarias?
- **A4. Menores**: ¿basta la aceptación del tutor con la casilla de la sección 3.2? ¿Cómo se acredita la tutela?
- **A5. Transferencias y servidores fuera de México** (5.4): ¿qué debe decir el aviso y qué cláusulas se requieren con Hostinger y Cloudflare?
- **A6. Conservación y cancelación** (5.5 y 6): plazos y bloqueo antes de supresión; derecho de cancelación frente a la obligación de conservar los datos del expediente, y copias de seguridad.
- **A7. Derechos ARCO** (4): plazos, forma de acreditar identidad, y revocación del consentimiento; autoridad competente vigente.
- **A8. Términos para médicos**: limitación de responsabilidad, descargo médico («no sustituye la valoración de un profesional»), verificación de la cédula, suspensión/bloqueo, uso del micrositio, y qué se dice del **cobro futuro** (hoy el piloto no cobra y no se debe prometer precio).
- **A9. Cookies**: ¿se requiere aviso o banner para cookies propias estrictamente necesarias?
- **A10. Portada y publicidad** (7.2): ¿alguna afirmación requiere sustento o descargo?
- **A11. Identidad del responsable** en los avisos (razón social, domicilio, medios de contacto): la empresa debe proporcionarlos.
- **A12. Textos de urgencia** (7.1): redacción del descargo y de la indicación de acudir a un hospital, en coordinación con la validación del dentista.
