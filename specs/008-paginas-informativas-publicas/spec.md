# Feature Specification: Páginas informativas públicas (Cómo funciona, Planes y Nosotros)

**Feature Branch**: `008-paginas-informativas-publicas` (sin rama propia: el trabajo sigue en `main`)

**Created**: 2026-11-27

**Status**: Draft

**Input**: User description: "Feature 8: Páginas públicas «Cómo funciona», «Planes» y «Nosotros» de agendadental.innvend.com, enlazadas desde una barra de menú única de la portada (feature 7). «Cómo funciona» explica qué es Agenda Dental (solución pensada para odontólogos en México que, mediante una suscripción, da a cada médico un micrositio para gestionar y dar seguimiento a sus citas), sus beneficios, funcionalidades y pasos. «Planes» muestra Esencial, Profesional y Élite con precios $499, $999 y $1,999 al mes (IVA incluido) y un descuento de 30 % (precio original tachado y precio con descuento). «Nosotros» dice que Agenda Dental es un producto desarrollado por Innvend Works (www.innvend.com), con texto y enlaces basados en su sitio. Todo con las reglas de la feature 7: públicas, sin formularios, sin JavaScript ni recursos de terceros, accesibles, sin indexar y con texto veraz."

## Contexto y estado actual

La feature 7 dejó una portada pública en `/` con su propia barra superior (logo «Agenda Dental», «Registrarme» e «Iniciar sesión») y su pie. Hoy **no existe ninguna otra página pública** que explique el servicio con más detalle, muestre cuánto cuesta ni diga quién está detrás. Esta feature añade tres páginas informativas y convierte la barra superior de la portada en la **barra de menú única del sitio público**, compartida por las cuatro páginas.

Esta feature **amplía lo que la feature 7 dejó fuera**: la portada excluía precios, planes y descuentos (FR-009 de esa spec). Ahora se publican, pero solo en la página «Planes» y con las salvaguardas de abajo; el resto de las reglas de veracidad se mantiene.

**Hechos de partida que condicionan el texto**:

- La plataforma del piloto ofrece reservar y cancelar citas en línea, avisos y recordatorios **por correo**, agenda configurable, micrositio con enlace propio, personal de recepción y separación de datos por consultorio. **No** tiene reprogramación, **WhatsApp** ni **cobro** (el cobro con Openpay y los topes de mensajes por plan están definidos en `docs/decisions/0001`, pero no construidos).
- La constitución fija el **alcance del piloto** (sin WhatsApp ni cobro automático con Openpay; reprogramación fuera de alcance) y la regla de **veracidad** de la feature 7 (FR-009) prohíbe anunciar lo que no existe. Los precios y el descuento son decisión de la persona responsable (27/11/2026), pero siguen **provisionales** hasta la revisión de Jurídico y Contabilidad, y no se hacen promesas de condiciones contractuales.
- Las urgencias en línea dependen de la validación de un dentista; por eso no se anuncian como disponibles.

## Clarificaciones

### Session 2026-11-27

- Decisión posterior: los precios con descuento se muestran **sin centavos**, redondeados al peso más cercano: $349, $699 y $1,399.

- Q: ¿Cómo se presenta el descuento del 30 % en cuanto a vigencia y duración? → A: Promoción de lanzamiento por tiempo limitado, sin fecha, con precios y condiciones sujetos a cambio; no se promete duración ni que aplique siempre.
- Q: ¿Se aclara en «Planes» que el cobro aún no está activo? → A: Sí: se indica que durante el piloto no se realiza ningún cobro y que el cobro se activará más adelante, con aviso previo.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Un médico entiende qué es Agenda Dental y cómo funciona (Priority: P1)

Un médico que llegó a la portada quiere saber, antes de registrarse, qué es exactamente el servicio. Abre «Cómo funciona» desde el menú y encuentra: qué es (una solución pensada para odontólogos en México que, por una suscripción, le da un micrositio propio para gestionar y dar seguimiento a sus citas), los beneficios, las funcionalidades y los pasos, tanto para él como para su paciente. Al final puede registrarse o iniciar sesión con un clic.

**Why this priority**: es la explicación que falta entre la portada y el registro; sin ella el médico decide con poca información.

**Independent Test**: abrir `/como-funciona` sin sesión; comprobar las secciones (qué es, beneficios, funcionalidades, pasos del médico y del paciente), que cada afirmación corresponde a una función existente y que los botones finales llevan al registro y al inicio de sesión.

**Acceptance Scenarios**:

1. **Given** una persona sin sesión, **When** abre «Cómo funciona», **Then** ve qué es Agenda Dental, sus beneficios, sus funcionalidades y los pasos, sin ningún formulario.
2. **Given** la página, **When** se lee de arriba abajo, **Then** ninguna frase promete reprogramación, WhatsApp u otra mensajería distinta al correo, cobro automático, rentabilidad, resultados económicos ni urgencias en línea.
3. **Given** el final de la página, **When** pulsa «Regístrate aquí» o «Iniciar sesión», **Then** llega al registro de médicos o al inicio de sesión respectivamente.

---

### User Story 2 - Un médico compara los planes y sus precios (Priority: P1)

El médico abre «Planes» y ve los tres planes —Esencial, Profesional y Élite—, qué incluye cada uno, su precio mensual original tachado y el precio con descuento del 30 %, todo con IVA incluido y en pesos. Entiende qué existe hoy y qué llegará después, que el descuento es una promoción de lanzamiento y que el cobro aún no está activo, y puede pasar al registro desde cada plan.

**Why this priority**: el precio es la duda más frecuente antes de registrarse y el descuento es un argumento comercial del lanzamiento; publicarlos mal (promesas no autorizadas o funciones inexistentes) es el mayor riesgo legal de la feature.

**Independent Test**: abrir `/planes`; comprobar los tres planes, los seis montos (tres originales tachados y tres con descuento) y que cada cifra con descuento es el 70 % de la original redondeado al peso; comprobar la leyenda de promoción, la leyenda de «Próximamente» en lo que depende de WhatsApp y la aclaración del cobro.

**Acceptance Scenarios**:

1. **Given** la página «Planes», **When** se lee, **Then** muestra Esencial ($499 → $349), Profesional ($999 → $699) y Élite ($1,999 → $1,399) al mes, con el precio original tachado, el precio con descuento destacado y la indicación «IVA incluido».
2. **Given** los topes de mensajes por plan (30 avisos de urgencia por WhatsApp en Esencial, 400 mensajes al mes en Profesional y 1,200 en Élite), **When** se muestran, **Then** llevan la etiqueta «Próximamente» y la página aclara que hoy los avisos salen por correo.
3. **Given** el plan Esencial, **When** se lee, **Then** indica que incluye una prueba de 5 días, y que Profesional y Élite no la incluyen.
4. **Given** la página, **When** se lee la promoción, **Then** dice que es una promoción de lanzamiento por tiempo limitado, que los precios y condiciones están sujetos a cambio, y que el cobro se activará más adelante con aviso previo (durante el piloto no se cobra).
5. **Given** cada plan, **When** pulsa «Regístrate aquí», **Then** llega al registro de médicos.

---

### User Story 3 - Quien llega por curiosidad sabe quién respalda el producto (Priority: P2)

Un médico quiere saber quién hizo Agenda Dental antes de dar sus datos. En «Nosotros» lee que es un producto desarrollado por Innvend Works, una empresa de software, datos e inteligencia artificial para empresas, y puede ir a su sitio (`www.innvend.com`) o escribirle desde los datos de contacto que la propia empresa publica.

**Why this priority**: da confianza, pero no bloquea el registro ni la comprensión del servicio.

**Independent Test**: abrir `/nosotros`; comprobar el texto sobre Innvend Works, el enlace a `https://www.innvend.com` (se abre sin entregar datos de la sesión) y los datos de contacto de Innvend; comprobar que no hay datos que el sitio de Innvend no muestre.

**Acceptance Scenarios**:

1. **Given** la página «Nosotros», **When** se lee, **Then** dice que Agenda Dental es un producto desarrollado por Innvend Works y resume a la empresa con base en lo que su propio sitio afirma.
2. **Given** el enlace «www.innvend.com», **When** se pulsa, **Then** abre el sitio de Innvend en otra pestaña, sin pasar información de Agenda Dental.
3. **Given** la página, **When** se buscan datos de la empresa, **Then** aparecen solo el correo y el teléfono que Innvend publica en su sitio, sin dirección, redes sociales ni nombres de personas.

---

### User Story 4 - Una barra de menú única conecta todas las páginas públicas (Priority: P1)

En cualquiera de las cuatro páginas públicas (Inicio, Cómo funciona, Planes y Nosotros) la persona ve la **misma barra superior**: el logo «Agenda Dental», los enlaces «Inicio», «Cómo funciona», «Planes» y «Nosotros», y a la derecha «Registrarme» e «Iniciar sesión». La página en la que está queda marcada. En el celular la barra sigue siendo utilizable sin JavaScript.

**Why this priority**: sin el menú las páginas nuevas serían inalcanzables; es lo que une la feature.

**Independent Test**: abrir cada página y comprobar que la barra es idéntica salvo la marca de la página actual, que cada enlace lleva a su destino y que a 390 px no hay desbordamiento ni controles inalcanzables.

**Acceptance Scenarios**:

1. **Given** cualquiera de las cuatro páginas, **When** se ve la barra, **Then** muestra los mismos enlaces en el mismo orden y marca solo el de la página actual.
2. **Given** una pantalla de 390 px, **When** se abre cualquiera de las páginas, **Then** el menú y los botones de acceso se reacomodan sin desbordar y todos se pueden pulsar.
3. **Given** un teclado, **When** se recorre la barra con Tab, **Then** el foco es visible y el orden es: logo, menú, «Registrarme», «Iniciar sesión».

---

### User Story 5 - Las páginas nuevas se leen bien en el celular, son accesibles y no cambian nada más (Priority: P2)

Las tres páginas se ven completas de 390 px a 1440 px, se recorren con teclado y lector de pantalla, no piden datos ni cargan nada de terceros y dejan el resto del sitio exactamente como estaba.

**Why this priority**: cubre calidad transversal; depende del contenido de las historias anteriores.

**Independent Test**: abrir cada página a 390 y 1440 px sin desplazamiento horizontal; recorrerlas con Tab; comprobar un solo encabezado principal, ausencia de formularios, scripts y recursos externos, y que las demás pantallas y rutas no cambiaron.

**Acceptance Scenarios**:

1. **Given** cada página nueva, **When** se carga, **Then** no hay formularios, scripts, estilos en línea, cookies ni peticiones a otros dominios.
2. **Given** un lector de pantalla, **When** recorre cualquiera de las páginas, **Then** encuentra un solo encabezado principal, regiones claras, enlaces comprensibles por sí solos, los precios tachados identificados como «precio anterior» y los íconos decorativos ignorados.
3. **Given** el resto del sitio, **When** se prueban el registro, el inicio de sesión y las pantallas con sesión, **Then** funcionan igual que antes.

---

### Edge Cases

- **Persona con sesión completa**: a diferencia de la raíz (que la lleva a su área), las tres páginas nuevas **se muestran a cualquiera**, con o sin sesión; no redirigen. La barra única sigue siendo la pública (no es el menú de trabajo del rol).
- **Sesión a medias**: las páginas se muestran con normalidad.
- **Cálculo de los precios con descuento**: se muestran **redondeados al peso, sin centavos** (decisión del 27/11/2026): el 70 % exacto ($349.30, $699.30 y $1,399.30) se redondea al peso más cercano (`$349`, `$699`, `$1,399`). Si algún día cambia un precio, el descuento se recalcula del original con la misma regla.
- **Lector de pantalla con precios tachados**: el precio original se anuncia como «precio anterior» y el nuevo como «precio con descuento», para que no se lea como dos precios vigentes.
- **Color como único indicador**: el precio tachado no depende solo del color; el tachado y el texto accesible lo distinguen.
- **Enlace externo a Innvend**: se abre en otra pestaña y sin conservar la referencia a Agenda Dental; si Innvend cambia su sitio, el enlace sigue apuntando a su dominio.
- **Teléfono y correo de Innvend sin cliente configurado**: el correo y el teléfono se muestran en el texto, no solo como enlace, para poder copiarlos.
- **Dirección repetida de la página**: `/como-funciona`, `/planes` y `/nosotros` son las únicas rutas; variantes (mayúsculas, barra final, `/planes/`) siguen el comportamiento habitual del sitio.
- **Planes mientras el cobro no existe**: ningún botón sugiere pagar ni contratar; solo llevan al registro, y la página aclara que durante el piloto no se cobra.
- **Texto legal de precios no revisado**: las páginas se publican igualmente (el registro sigue bloqueado por la revisión legal de la feature 7), pero la promoción queda marcada como provisional en la documentación y en la lista de pendientes.
- **JavaScript desactivado, zoom 200 %, «reducir movimiento»**: sin cambios; las páginas no dependen de ninguno.

## Requirements *(mandatory)*

### Functional Requirements

**Barra de menú única**

- **FR-001**: Las cuatro páginas públicas (`/`, `/como-funciona`, `/planes` y `/nosotros`) MUST compartir la **misma barra superior**: logo y nombre «Agenda Dental» a la izquierda (llevan a `/`); enlaces «Inicio» (`/`), «Cómo funciona» (`/como-funciona`), «Planes» (`/planes`) y «Nosotros» (`/nosotros`); y a la derecha «Registrarme» (registro de médicos) e «Iniciar sesión» (inicio de sesión, con su ícono). No existe ninguna otra barra pública.
- **FR-002**: La barra MUST marcar la página actual como tal para las tecnologías de apoyo y visualmente, y MUST ser utilizable de 390 px a 1440 px sin JavaScript: en pantallas estrechas los enlaces se reacomodan sin desbordar y todos se pueden pulsar (altura mínima táctil de 44 px).
- **FR-003**: La barra de la portada (feature 7) MUST pasar a ser esta barra única, conservando sus enlaces y destinos actuales («Registrarme» e «Iniciar sesión»); los enlaces y textos de la portada no cambian, salvo la adición del menú.

**Cómo funciona**

- **FR-004**: `/como-funciona` MUST mostrar a cualquier persona, con o sin sesión, una página con un solo encabezado principal y las secciones: **qué es Agenda Dental** (FR-005), **beneficios**, **funcionalidades**, **cómo funciona para el médico**, **cómo funciona para el paciente** y una **llamada final** con «Regístrate aquí» (registro de médicos) e «Iniciar sesión» (inicio de sesión).
- **FR-005**: La sección «qué es» MUST decir, en esencia: Agenda Dental es una solución diseñada y pensada especialmente para la comunidad de odontólogos en México que, mediante una suscripción, permite que cada médico tenga un micrositio propio para llevar la gestión y el seguimiento de sus citas.
- **FR-006**: **Beneficios** (cada uno MUST corresponder a una capacidad existente del piloto; sin cifras ni resultados económicos):
  1. **Agenda ordenada**: horarios, duración de cita, pausa y bloqueos que el médico configura, con anticipación mínima y máxima de reserva.
  2. **Sin dobles reservas**: los pacientes solo ven y reservan espacios libres.
  3. **Menos llamadas**: el paciente reserva y cancela en línea desde el celular, sin llamar.
  4. **Menos inasistencias**: confirmación y recordatorio por correo con enlace para ver o cancelar la cita.
  5. **Presencia propia**: un micrositio con el nombre, la ubicación (con «Cómo llegar»), el teléfono y el logo del consultorio.
  6. **Orden y privacidad**: los datos de cada consultorio y de sus pacientes están separados de los de otros consultorios; los pacientes aceptan un aviso de privacidad con consentimiento expreso.
- **FR-007**: **Funcionalidades** MUST describir, en lenguaje sencillo y solo con lo que el piloto tiene: micrositio con enlace propio (`/c/nombre` elegido por el médico); calendario por día y semana; horarios, duración de cita, pausa y bloqueos configurables; reserva de pacientes sin doble reserva; cancelación por el paciente hasta 24 horas antes (configurable por el médico) y cancelación por el médico con aviso al paciente por correo; correos de confirmación y de recordatorio con enlace; cuentas de personal de recepción para colaborar con la agenda; separación de datos por consultorio; revisión de cada solicitud de médico por el equipo de soporte antes de activar la cuenta.
- **FR-008**: **Pasos del médico**: (1) se registra y soporte valida su cédula profesional en el Registro Nacional de Profesionistas y su identificación oficial; (2) configura su calendario y crea su micrositio; (3) comparte su enlace; (4) sus pacientes reservan y reciben avisos por correo; (5) gestiona y da seguimiento a sus citas. **Pasos del paciente**: (1) entra al enlace del consultorio; (2) elige día y horario; (3) recibe la confirmación por correo; (4) puede cancelar su cita desde el enlace dentro del plazo.
- **FR-009**: «Cómo funciona» MUST NOT mencionar como disponibles: reprogramación, WhatsApp u otra mensajería distinta al correo, cobro o pasarela de pago, urgencias en línea, historial clínico, rentabilidad, resultados económicos, cifras de mejora ni testimonios. La aclaración de que hay avisos por WhatsApp «Próximamente» solo aparece en «Planes».

**Planes**

- **FR-010**: `/planes` MUST mostrar a cualquier persona, con o sin sesión, los tres planes de la definición del proyecto (`docs/decisions/0001`, «Planes y cobro»), en este orden: **Esencial**, **Profesional** y **Élite**, cada uno con su nombre, su precio mensual original, su precio con descuento, lo que incluye y un botón «Regístrate aquí» al registro de médicos.
- **FR-011**: Precios, en MXN y **con IVA incluido** (decisión del 27/11/2026): Esencial $499, Profesional $999 y Élite $1,999 al mes. Con el descuento del **30 %** aplicado a todos los planes: Esencial **$349**, Profesional **$699** y Élite **$1,399** al mes (precio original × 0.70, redondeado al peso más cercano y mostrado sin centavos). El precio original MUST mostrarse **tachado** y el precio con descuento **destacado**; ambos MUST indicar «al mes» e «IVA incluido»; el tachado MUST ir identificado para tecnologías de apoyo («precio anterior»).
- **FR-012**: **Lo que incluye cada plan** MUST basarse en la definición del proyecto, separando lo que existe hoy de lo que llegará: todos los planes incluyen hoy lo descrito en «Cómo funciona» y avisos por correo. Los topes de mensajes —**30 avisos de urgencia por WhatsApp al mes (Esencial), 400 mensajes al mes (Profesional) y 1,200 mensajes al mes (Élite)**— MUST llevar la etiqueta «Próximamente», y la página MUST aclarar que **hoy los avisos salen por correo**. Esencial MUST indicar una **prueba de 5 días**; Profesional y Élite MUST indicar que no incluyen prueba.
- **FR-013**: **Promoción** (clarificación del 27/11/2026): la oferta del 30 % MUST presentarse como **promoción de lanzamiento por tiempo limitado, con precios y condiciones sujetos a cambio**; MUST NOT mostrar una fecha de vigencia ni prometer que el descuento dure o aplique siempre, ni afirmar condiciones de cobro, renovación o cancelación.
- **FR-014**: **Cobro** (clarificación del 27/11/2026): la página MUST aclarar que **durante el piloto no se realiza ningún cobro** y que **el cobro se activará más adelante, con aviso previo**. Ningún elemento de «Planes» MUST sugerir que se puede pagar, contratar o suscribirse en línea: los botones solo llevan al registro.
- **FR-015**: Los precios, el descuento y los topes por plan MUST quedar documentados como **provisionales hasta la revisión de Jurídico y Contabilidad** (en `docs/legal/paquete-para-revision-legal.md` y en el registro de decisiones de la feature), sin mostrar esa leyenda interna al público; en la página solo aparece la leyenda de promoción de FR-013 y la aclaración de FR-014.
- **FR-016**: Los montos de la página MUST salir de **una sola fuente de datos** (los tres precios originales y el porcentaje de descuento), de modo que el precio con descuento se calcule y no se escriba a mano, y MUST existir una prueba que verifique que cada precio con descuento es el 70 % del original redondeado al peso más cercano y que los textos de «Planes» coinciden con ella.

**Nosotros**

- **FR-017**: `/nosotros` MUST mostrar a cualquier persona, con o sin sesión, que **Agenda Dental es un producto desarrollado por Innvend Works** y MUST incluir un enlace a `https://www.innvend.com` (texto visible «www.innvend.com») que se abra en otra pestaña **sin entregar la referencia de origen**.
- **FR-018**: El texto sobre Innvend Works MUST basarse solo en lo que su propio sitio afirma (leído el 27/11/2026): empresa de «Software, datos e IA para empresas» que ayuda a las empresas a operar mejor mediante software, datos e inteligencia artificial; combina consultoría, desarrollo de software a medida y productos propios; más de 20 años de experiencia. MUST incluir el contacto público de Innvend (correo `contacto@innvend.com` y teléfono `(52) 33 1241 5547`, visibles como texto y como enlaces) y MUST NOT inventar datos que ese sitio no muestre (dirección, redes sociales, nombres de personas, clientes o cifras).
- **FR-019**: El contacto de Innvend en «Nosotros» MUST distinguirse del contacto del pie del sitio (el buzón público de contacto de Agenda Dental ya configurado): el pie no cambia ni se duplica, y el texto aclara que el contacto de «Nosotros» es el de la empresa que desarrolla el producto.

**Transversales**

- **FR-020**: Las tres páginas nuevas MUST usar la hoja de estilos, las fuentes y los componentes ya existentes, sin estilos en línea, sin JavaScript, sin formularios, sin cookies y sin ningún recurso de terceros; la política de seguridad de contenido actual no se amplía. Los únicos enlaces a otro dominio son los de navegación hacia `www.innvend.com` (y su correo y teléfono) de «Nosotros»; las guardias que hoy prohíben cualquier dirección externa en las páginas públicas MUST actualizarse con una **excepción explícita y acotada** a ese dominio, de modo que sigan detectando cualquier otro.
- **FR-021**: Cada página MUST tener un solo encabezado principal, regiones de cabecera, contenido y pie, «Saltar al contenido», enlaces con texto comprensible por sí solos, íconos decorativos ocultos a tecnologías de apoyo, contraste mínimo de 4.5:1, foco visible y respeto a «reducir movimiento»; MUST ser utilizable de 390 px a 1440 px sin desplazamiento horizontal.
- **FR-022**: Cada página MUST llevar un título y una descripción propios, en español, sin promesas que incumplan FR-009 y FR-013, y MUST seguir **sin indexarse** durante el piloto (como la portada). Las páginas MUST llevar el mismo pie de la portada.
- **FR-023**: Las tres rutas MUST aceptar solo lectura (`GET`/`HEAD`), llevar el mismo límite de peticiones por IP que la portada, no guardarse en caché del navegador (regla común del HTML del sitio) y no consultar la base de datos.
- **FR-024**: Esta feature MUST NOT cambiar el registro de médicos, el inicio de sesión, el cobro ni ninguna pantalla con sesión, sus rutas, métodos o campos; solo añade las tres rutas, la barra única y sus pruebas.
- **FR-025**: Las páginas MUST estar cubiertas por pruebas automáticas que verifiquen: la barra idéntica en las cuatro páginas con solo la actual marcada; los destinos de cada enlace; los seis montos y el cálculo del 70 % redondeado al peso; las etiquetas «Próximamente», la promoción y la aclaración del cobro; la ausencia de términos prohibidos (reprogramación, WhatsApp fuera de «Planes», rentabilidad, resultados, urgencias en línea); la ausencia de formularios, scripts, estilos en línea y recursos externos salvo la excepción de FR-020; un solo encabezado principal; y que las páginas son públicas para todos los roles.

### Key Entities

- **Plan**: oferta de suscripción mensual con nombre (Esencial, Profesional o Élite), precio original en MXN con IVA incluido, porcentaje de descuento (el mismo para todos), precio con descuento calculado, prueba (5 días o ninguna) y tope de mensajes de WhatsApp «Próximamente». Es contenido fijo de la página (no hay datos de personas ni tabla en la base de datos).
- **Entrada de menú**: nombre visible y destino de cada enlace de la barra única (Inicio, Cómo funciona, Planes y Nosotros, más «Registrarme» e «Iniciar sesión»).

No se guarda ni se lee información de personas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Desde cualquiera de las cuatro páginas públicas, una persona llega a cualquiera de las otras tres con **un solo clic** (4 de 4 páginas, 12 de 12 combinaciones).
- **SC-002**: Una persona sin sesión llega al formulario de registro con un solo clic desde cualquiera de las cuatro páginas (barra, botones de plan o llamada final).
- **SC-003**: El 100 % de las afirmaciones sobre la plataforma en «Cómo funciona» y «Planes» corresponden a funciones existentes en el piloto o llevan la etiqueta «Próximamente»; 0 promesas de reprogramación, WhatsApp disponible, cobro activo, rentabilidad, resultados o urgencias en línea.
- **SC-004**: Los 6 montos de «Planes» son correctos: los 3 precios con descuento son el 70 % del original redondeado al peso (sin centavos) y coinciden con la fuente única de datos; 0 discrepancias entre la página y la prueba.
- **SC-005**: A 390 px y a 1440 px de ancho, 0 desplazamientos horizontales en las cuatro páginas y el 100 % de los botones y enlaces de la barra con al menos 44 px de alto.
- **SC-006**: Al cargar cualquier página nueva, 0 peticiones a otros dominios, 0 cookies y 0 scripts; las únicas direcciones externas son los enlaces de navegación a `www.innvend.com`, su correo y su teléfono.
- **SC-007**: Cada página nueva pesa menos de 30 KB de HTML y se muestra en menos de 2 segundos con conexión normal.
- **SC-008**: Todos los controles de las cuatro páginas se pueden alcanzar y activar solo con teclado, con foco visible, en el 100 % de los casos probados; cada página tiene un solo encabezado principal.
- **SC-009**: Las tres páginas se muestran sin redirigir a los 4 roles con sesión completa y a quien no tiene sesión (5 de 5 casos), y las pantallas existentes (registro, inicio de sesión y áreas con sesión) pasan sus pruebas sin cambios.

## Assumptions

- **Sin cobro todavía**: la plataforma no cobra; los precios se publican como información comercial provisional y la página lo aclara (FR-014). Construir el cobro (Openpay), la prueba de 5 días como mecanismo, el contador de mensajes de WhatsApp y los avisos al 80 % está **fuera de alcance**; la constitución mantiene el piloto sin WhatsApp ni cobro automático.
- La **prueba de 5 días** de Esencial viene de la definición del proyecto; se describe como característica del plan, sin prometer condiciones al terminar la prueba (el 72 h de plazo y el modo de solo lectura de la definición son del cobro y no se publican).
- **Precios y descuento** son decisión de la persona responsable (27/11/2026). El descuento es un solo porcentaje (30 %) para los tres planes; se muestra el precio original y el precio con descuento. La promoción se presenta sin fecha ni duración (clarificación del 27/11/2026).
- **Revisión legal pendiente**: los precios, el descuento, los topes y la aclaración del cobro son provisionales hasta que Jurídico y Contabilidad los validen; el registro de médicos sigue bloqueado en producción hasta la revisión de los avisos (feature 7).
- Los topes de mensajes se publican **tal cual la definición** (30, 400 y 1,200) con «Próximamente»; el exceso por mensaje y el tope de 100 por ciclo **no** se publican (son una condición de cobro aún no autorizada).
- El texto de «Nosotros» se basa en el sitio de Innvend leído el 27/11/2026; si Innvend lo cambia, el texto de Agenda Dental no se actualiza solo. No se publican datos que ese sitio no muestre.
- «Innvend Works» es el nombre con que la persona responsable pidió presentar a la empresa; su sitio la nombra «Innvend». El texto usa «Innvend Works» y enlaza a `www.innvend.com`.
- Las urgencias en línea **no** se anuncian como disponibles (dependen de la validación de un dentista); si más adelante se habilitan, se añade en una feature aparte. El texto «30 avisos de urgencia por WhatsApp» de Esencial solo aparece como beneficio «Próximamente» de «Planes».
- Las páginas siguen sin indexarse en buscadores durante el piloto cerrado; abrirlas es un cambio posterior de una sola marca.
- Las tres páginas solo están en español de México, sin selector de idioma, y usan el mismo pie, el mismo año del reloj del servidor en UTC y el mismo correo de contacto de Agenda Dental que la portada.
- Los íconos son dibujos vectoriales propios (los existentes y los nuevos que hagan falta), sin librerías ni fuentes de íconos.
- El menú de la barra se muestra igual a quien tiene sesión: es la barra pública del sitio informativo, no sustituye el menú de trabajo de cada rol (que sigue en las pantallas con sesión).
- Dependencias: la hoja de estilos, las fuentes y los componentes de la feature 6; la portada y su vista de la feature 7; los destinos `/medicos/registro` y `/login`; y las guardias y pruebas existentes de la portada (`landing.test.ts`, `landing-copy.test.ts`, `design-*.test.ts`, `route-audit.test.ts`), que habrá que ampliar.
