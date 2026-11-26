# Feature Specification: Página de inicio pública

**Feature Branch**: `007-pagina-de-inicio-publica` (sin rama propia: el trabajo sigue en `main`)

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Feature 7: Página de inicio pública de agendadental.innvend.com (ruta raíz «/»). Crear una página de inicio de entrada para médicos y consultorios dentales, con la identidad visual vigente (feature 6), tomando como referencia la imagen aportada: barra superior (logo, «Agenda Dental», «Registrarme», «Iniciar sesión»), sección principal con titular «Tu consultorio, en orden. / Tus pacientes, a un mensaje de distancia.» y los botones «Regístrate aquí» y «Ya tengo cuenta», cinco tarjetas de beneficios, banda de llamada a la acción y pie con aviso de privacidad, términos y contacto. «Registrarme» y «Regístrate aquí» llevan al registro de médicos; «Iniciar sesión» y «Ya tengo cuenta» llevan al inicio de sesión. Sin formularios, sin JavaScript ni recursos de terceros. Una persona con sesión que abre la raíz va a su área. Los textos no deben prometer lo que la plataforma del piloto no tiene (reprogramación, WhatsApp, rentabilidad)."

## Contexto y estado actual

Hoy la raíz del sitio (`https://agendadental.innvend.com/`) **no responde con una página**: quien escribe solo el dominio ve el error «no encontrado». El acceso real es por `/login` (todos los roles) y `/medicos/registro` (alta de médicos, que soporte aprueba a mano). Las features 1 a 6 dejaron todas las pantallas con el mismo diseño y sin recursos de terceros; esta feature añade la **puerta de entrada pública** que explica el servicio y lleva a esos dos destinos, sin cambiarlos.

La imagen de referencia propone el contenido y el orden de la portada. Su texto, sin embargo, menciona **reprogramar citas, mensajería, recordatorios automáticos y rentabilidad**, y la plataforma del piloto solo ofrece reservar y cancelar en línea y avisos **por correo** (sin WhatsApp ni reprogramación). La constitución prohíbe prometer lo que no existe, por lo que el texto final es una decisión de producto (ver FR-009).

**Sitio de la portada**: es una pantalla más del sitio, pero **no usa la barra lateral** ni la tarjeta centrada de las pantallas de trabajo: tiene su propia barra superior, secciones de ancho completo y pie, con la misma paleta, tipografía y componentes de la feature 6.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Un médico conoce el servicio y empieza su registro (Priority: P1)

Una persona (médico o dueño de un consultorio dental) abre `agendadental.innvend.com`. Ve de inmediato qué es «Agenda Dental», para quién es y qué le ofrece, y con un solo clic llega al formulario para registrar a su consultorio: desde «Registrarme» en la barra superior, desde «Regístrate aquí» en la sección principal o desde el botón de la banda final.

**Why this priority**: es el propósito de la portada: convertir una visita en una solicitud de registro (que soporte aprobará). Sin ella, quien llega al dominio no tiene un siguiente paso.

**Independent Test**: abrir la raíz sin sesión y comprobar que hay tres enlaces de registro (barra, sección principal y banda) y que cada uno abre `/medicos/registro`; comprobar que la página no pide ningún dato.

**Acceptance Scenarios**:

1. **Given** una persona sin sesión, **When** abre la raíz del sitio, **Then** ve la portada completa con el nombre «Agenda Dental», el titular, la explicación, los beneficios y la llamada a la acción, y ningún formulario.
2. **Given** la portada, **When** pulsa «Registrarme» (barra superior), «Regístrate aquí» (sección principal) o «Regístrate aquí» (banda final), **Then** llega a la pantalla de registro de médicos.
3. **Given** la portada, **When** la lee de arriba abajo, **Then** cada afirmación sobre lo que hace la plataforma es cierta para el piloto (sin reprogramación, WhatsApp ni promesas de precio o resultados).

---

### User Story 2 - Quien ya tiene cuenta entra sin buscar el enlace (Priority: P1)

Un médico, una persona de recepción, soporte o un paciente que abre el dominio encuentra «Iniciar sesión» (barra superior) y «Ya tengo cuenta» (sección principal), y ambos llevan a la pantalla de inicio de sesión. Si ya tiene la sesión iniciada, la raíz lo manda directamente a su área, igual que ya hace `/login`.

**Why this priority**: todos los roles entran por el mismo inicio de sesión; la portada es ahora el primer lugar donde buscan el acceso.

**Independent Test**: abrir la raíz sin sesión y pulsar los dos enlaces de acceso (ambos van a `/login`); iniciar sesión y abrir la raíz de nuevo (redirige al área del rol sin mostrar la portada).

**Acceptance Scenarios**:

1. **Given** la portada sin sesión, **When** pulsa «Iniciar sesión» o «Ya tengo cuenta», **Then** llega a la pantalla de inicio de sesión.
2. **Given** una persona con sesión completa (médico, recepción, soporte o paciente), **When** abre la raíz, **Then** es redirigida a la pantalla de inicio de su rol, sin ver la portada.
3. **Given** una persona con la sesión a medias (segundo factor pendiente), **When** abre la raíz, **Then** ve la portada y sus enlaces de acceso la llevan al inicio de sesión, que ya resuelve ese caso.

---

### User Story 3 - La portada se lee bien en el celular y es accesible (Priority: P2)

La mayoría de las visitas vendrá de un celular o de un enlace compartido. La portada se ve completa y cómoda de 390 px a 1440 px: la barra superior, los dos botones principales, las cinco tarjetas y la banda se reacomodan sin desbordar, los botones se pueden pulsar con el dedo, y el contenido se puede recorrer con teclado y con lector de pantalla.

**Why this priority**: es lo que decide si la primera impresión funciona, pero depende del contenido de la historia 1.

**Independent Test**: abrir la portada a 390 px y a 1440 px (sin desplazamiento horizontal); recorrerla con Tab (foco visible, orden lógico, «Saltar al contenido» disponible); comprobar un solo encabezado principal.

**Acceptance Scenarios**:

1. **Given** una pantalla de 390 px, **When** se abre la portada, **Then** no hay desplazamiento horizontal, las tarjetas se apilan y los botones miden al menos 44 px de alto.
2. **Given** un lector de pantalla, **When** recorre la página, **Then** encuentra una sola idea principal (el titular), regiones claras (cabecera, contenido y pie), enlaces con texto comprensible y los íconos decorativos ignorados.
3. **Given** la preferencia «reducir movimiento», **When** se abre la portada, **Then** no hay transiciones.

---

### User Story 4 - Contacto y textos legales a la vista (Priority: P3)

En el pie, la persona encuentra «Aviso de privacidad», «Términos y condiciones» y «Contacto». Los dos primeros abren los textos legales vigentes para médicos; «Contacto» abre un correo al buzón público de contacto ya configurado, sin crear una pantalla ni un formulario nuevos.

**Why this priority**: es lo que da confianza a quien va a dar sus datos y la constitución exige que el aviso de privacidad sea accesible; el resto de la portada no depende de ello.

**Independent Test**: pulsar cada enlace del pie y comprobar el destino (los dos textos legales vigentes y un enlace de correo al buzón de contacto).

**Acceptance Scenarios**:

1. **Given** el pie de la portada, **When** pulsa «Aviso de privacidad» o «Términos y condiciones», **Then** abre el texto legal vigente dirigido a médicos.
2. **Given** el pie, **When** pulsa «Contacto», **Then** se abre un mensaje de correo dirigido al buzón público de contacto del sitio.
3. **Given** el pie, **When** se lee, **Then** muestra «© » con el año en curso y «Agenda Dental».

---

### Edge Cases

- **Texto legal no publicado todavía**: los enlaces legales apuntan a los textos existentes; si alguno no estuviera disponible, el resto de la portada sigue funcionando y el enlace muestra la pantalla de «no encontrado» de siempre.
- **Sesión a medias o por activar el segundo factor**: la portada se muestra; los enlaces de acceso llevan al inicio de sesión, que ya sabe qué hacer.
- **Cuenta en solo lectura o suspendida con sesión**: la raíz la lleva a su área como a cualquier sesión; la portada no decide nada sobre el estado de la cuenta.
- **Rastreadores de buscadores**: lo que hagan con la portada depende de la decisión de indexación (FR-014).
- **JavaScript desactivado**: no cambia nada (la portada no usa JavaScript).
- **Zoom del 200 % y texto grande del sistema**: el contenido sigue legible y los botones accesibles, sin pérdida de información.
- **Titular largo en pantallas estrechas**: el titular de dos líneas se parte sin desbordar y conserva el contraste.
- **Enlaces de correo sin cliente de correo configurado**: el enlace «Contacto» muestra la dirección en el propio texto o su descripción accesible, para poder copiarla.
- **Peticiones repetidas a la raíz**: aplica el mismo límite de peticiones por IP que a las demás pantallas públicas.
- **`HEAD` y rutas parecidas** (`/index.html`, `/inicio`): fuera de alcance; solo la raíz es la portada.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: La raíz del sitio (`/`) MUST mostrar la página de inicio pública a cualquier persona sin sesión, sin pedir datos y sin ningún formulario.
- **FR-002**: La barra superior MUST mostrar el logo y el nombre «Agenda Dental» a la izquierda y, a la derecha, un enlace «Registrarme» y un botón con borde «Iniciar sesión» con un ícono de entrada. El logo y el nombre MUST llevar a la propia portada.
- **FR-003**: La sección principal MUST mostrar una etiqueta «Agenda en línea para consultorios dentales», un titular de dos líneas —«Tu consultorio, en orden.» en el color de texto y «Tus pacientes, a un mensaje de distancia.» en el color primario—, un párrafo explicativo —«Tus pacientes prefieren agendar como hacen todo lo demás: desde su celular, en segundos y sin llamadas. Agenda Dental les permite reservar y cancelar sus citas en línea y recibir avisos por correo, mientras tú tienes toda tu agenda bajo control.»— y dos botones: «Regístrate aquí» (primario, con flecha) y «Ya tengo cuenta» (secundario).
- **FR-004**: La portada MUST incluir una sección de beneficios con el título «La agenda es el punto de partida de un consultorio que funciona bien.», la introducción «Con ella bien gestionada puedes:» y cinco tarjetas, cada una con un ícono decorativo y una frase veraz (decisión del 26/11/2026, opción A de la clarificación):
  1. «Planear con certeza tu semana, con los horarios, la duración de cita y los bloqueos que tú eliges.»
  2. «Aprovechar al máximo cada consulta: tus pacientes solo reservan espacios libres, sin dobles reservas.»
  3. «Cumplir los tiempos de cada consulta con la duración y la pausa que tú configuras.»
  4. «Reducir las inasistencias con recordatorios por correo.»
  5. «Mantener tu agenda y los datos de tus pacientes separados de los de otros consultorios.»
- **FR-005**: La portada MUST incluir una banda de llamada a la acción en color primario con el titular «Menos llamadas y una agenda más ordenada.», el texto «Crea la cuenta de tu consultorio y empieza a recibir citas en línea. Revisamos cada solicitud antes de activar la cuenta.» y un botón blanco «Regístrate aquí».
- **FR-006**: El pie MUST mostrar «© » con el **año en curso** y «Agenda Dental», y tres enlaces: «Aviso de privacidad» y «Términos y condiciones» (que abren los textos legales vigentes para médicos ya existentes) y «Contacto» (un enlace de correo al buzón público de contacto ya configurado). No se crea ninguna pantalla ni formulario nuevos.
- **FR-007**: Destinos de los botones: «Registrarme» y los dos «Regístrate aquí» MUST llevar al registro de médicos; «Iniciar sesión» y «Ya tengo cuenta» MUST llevar al inicio de sesión. Ningún otro botón o enlace de acción lleva a otra parte.
- **FR-008**: Una persona con **sesión completa** que abra la raíz MUST ser redirigida a la pantalla de inicio de su rol (la misma lógica que hoy aplica `/login`), sin mostrar la portada. Con la sesión a medias se muestra la portada.
- **FR-009**: **Veracidad del contenido**: ninguna frase de la portada puede afirmar o insinuar una función que la plataforma del piloto no tiene (reprogramar citas, WhatsApp o mensajería distinta al correo, rentabilidad o resultados económicos, precios, planes, descuentos, cifras o testimonios inventados) ni condiciones contractuales. Decisión de la persona responsable (26/11/2026, opción A): se **reescribe** el texto de la imagen de referencia con lo que sí existe; no se usa «reprogramar», «mensajería», «recordatorios automáticos» ni «rentabilidad», ni «más pacientes satisfechos». Los textos definitivos son los de FR-003 a FR-005; lo que la plataforma del piloto SÍ ofrece (lista de capacidades contra la que se verifica la portada) es: reservar y cancelar citas en línea; avisos y recordatorios por correo; agenda por día y semana; horarios, duración, pausa y bloqueos configurables; micrositio propio con enlace; personal de recepción; sin dobles reservas; datos separados por consultorio. Quedan **fuera** de la portada: reprogramación, WhatsApp u otra mensajería, cobro y precios, rentabilidad o resultados, historial clínico y las urgencias en línea (dependen de la validación de un dentista).
- **FR-010**: La portada MUST usar la hoja de estilos, las fuentes y los componentes de la feature 6, sin estilos en línea, sin JavaScript y sin ningún recurso de terceros; la política de seguridad de contenido actual no se amplía.
- **FR-011**: La portada MUST ser utilizable de 390 px a 1440 px sin desplazamiento horizontal de la página; los botones y enlaces de acción MUST medir al menos 44 px de alto en pantallas táctiles; las cinco tarjetas MUST apilarse o reacomodarse en pantallas estrechas.
- **FR-012**: Accesibilidad: un solo encabezado principal (el titular), regiones de cabecera, contenido principal y pie, «Saltar al contenido», enlaces con texto comprensible por sí solos, íconos decorativos ocultos a tecnologías de apoyo, contraste mínimo de 4.5:1, foco visible y respeto a «reducir movimiento». Los botones repetidos («Regístrate aquí») conservan el mismo destino y nombre.
- **FR-013**: La portada MUST llevar un título de página y una descripción en español que expliquen qué es el servicio, sin promesas que incumplan FR-009.
- **FR-014**: **Indexación**: durante el piloto cerrado la portada sigue como el resto del sitio, **sin indexar** (decisión del 26/11/2026, opción A). Cuando se abra el registro se podrá cambiar esta marca sin tocar nada más.
- **FR-015**: La portada MUST NOT establecer cookies ni usar analítica o seguimiento: es una página informativa sin datos personales.
- **FR-016**: Esta feature MUST NOT cambiar el registro de médicos, el inicio de sesión ni ninguna otra pantalla existente, sus rutas, métodos o campos; solo añade la raíz y sus pruebas.
- **FR-017**: La portada MUST estar cubierta por pruebas automáticas que verifiquen los destinos de cada enlace, la ausencia de formularios y de recursos externos, un solo encabezado principal, los textos clave, la redirección con sesión y el cumplimiento de las guardias de diseño de la feature 6.

### Key Entities

No hay datos nuevos: la portada no guarda ni lee información de personas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de los enlaces de acción de la portada llevan al destino definido: 3 al registro de médicos, 2 al inicio de sesión (más el logo a la portada, los 2 textos legales y el correo de contacto en el pie).
- **SC-002**: Una persona sin sesión llega al formulario de registro con **un solo clic** desde cualquier punto de la portada (barra superior, sección principal o banda final).
- **SC-003**: El 100 % de las afirmaciones de la portada se corresponden con funciones existentes en el piloto, verificado contra una lista de capacidades revisada por la persona responsable (0 promesas de reprogramación, WhatsApp, precios o resultados económicos).
- **SC-004**: A 390 px y a 1440 px de ancho, 0 desplazamientos horizontales de la página y el 100 % de los botones con al menos 44 px de alto.
- **SC-005**: Al cargar la portada, 0 peticiones a dominios que no sean el propio sitio y 0 cookies establecidas.
- **SC-006**: La portada (HTML y hoja de estilos ya servida) se muestra en menos de 2 segundos con conexión normal y su HTML pesa menos de 30 KB.
- **SC-007**: Una persona con sesión completa que abre la raíz llega a su área con una sola redirección y sin ver contenido de la portada (4 de 4 roles).
- **SC-008**: Todos los controles de la portada se pueden alcanzar y activar solo con teclado, con foco visible, en el 100 % de los casos probados.

## Assumptions

- La imagen de referencia define el **orden y la estructura** de la portada, no la medida exacta de cada píxel ni su texto literal (que se reescribió por veracidad, FR-009); se respetan la paleta, las fuentes y los componentes de la feature 6.
- El titular «Tus pacientes, a un mensaje de distancia.» se conserva como figura retórica (el paciente reserva en línea); si la persona responsable prefiere «a un clic de distancia», se cambia solo el texto.
- La portada está pensada para **médicos y dueños de consultorio**; el paciente llega a su consultorio por el enlace público `/c/<nombre>` y el inicio de sesión es común a todos los roles.
- **Piloto cerrado**: el registro de médicos sigue siendo una solicitud que soporte aprueba a mano; la portada no la vuelve automática ni cambia el alcance del piloto (la constitución mantiene fuera de alcance el registro abierto con verificación automática).
- «Aviso de privacidad» y «Términos y condiciones» del pie apuntan a los textos para **médicos** (que ya existen y se muestran en el registro); siguen siendo los textos provisionales hasta que un abogado los revise, y esa revisión sigue bloqueando la entrada de pacientes reales.
- «Contacto» usa el correo público de contacto que ya existe para los derechos sobre los datos personales (`RIGHTS_CONTACT_EMAIL`); no se publica el correo interno al que llegan los avisos de nuevos médicos.
- Los íconos del logo y de las tarjetas son dibujos vectoriales propios (los de la feature 6 y los nuevos que haga falta), sin librerías ni fuentes de íconos.
- El año del pie es el del reloj del servidor en el momento de mostrar la página.
- La portada solo está en español de México; no hay selector de idioma.
- Sin precios, planes, formulario de contacto, demostración interactiva, blog, WhatsApp ni reprogramación (fuera de alcance).
- Por defecto las páginas HTML del sitio no se guardan en caché; la portada sigue esa regla salvo que el plan decida lo contrario por rendimiento.
- **Dependencia conocida (decisión del 26/11/2026, opción b)**: mientras los textos legales de médico (`doctor_privacy` y `terms_doctor`) sean provisionales, el registro de médicos **no está abierto en producción**: al enviar el formulario responde con el aviso ya existente «El registro todavía no está disponible: estamos terminando la revisión legal de nuestros avisos. Inténtalo de nuevo más adelante.». La portada se publica igualmente y sus botones llevan al formulario sin cambiarlo (FR-016); el registro funciona en cuanto un abogado revise esos textos y se publiquen. Mejorar el formulario para avisarlo antes de llenarlo es una mejora aparte.
- El año del pie es el del reloj del servidor en UTC; en la noche de fin de año en México puede adelantarse unas horas (aceptado).
- Una persona con sesión completa que tenga avisos legales por aceptar (o soporte sin el segundo factor activo) y abra la raíz pasa por los filtros globales de esas reglas antes de la redirección al área, igual que en el resto del sitio (se la lleva a aceptarlos o a activar el factor).
