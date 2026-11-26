# Feature Specification: Diseño visual del sitio

**Feature Branch**: `006-diseno-visual-del-sitio` (sin rama propia: el trabajo sigue en `main`)

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Feature 6: Diseño visual del sitio. Hoy todas las pantallas de la app son HTML plano sin estilos. Aplicar un sistema visual profesional, minimalista y moderno, con colores frescos (verde azulado, menta y azul cielo), de forma consistente en todas las pantallas existentes, sin cambiar la funcionalidad. Referencia: el documento «Spec de diseño — Agenda Dental» aportado por la persona responsable, tomando solo lo que aplica a este sitio. Sin funciones nuevas (sin campana de notificaciones, buscador de encabezado, mini calendario, tarjeta «Siguiente paciente», métricas nuevas ni secciones de menú que hoy no existen). Sin pedir recursos a servicios de terceros desde el navegador del paciente."

## Contexto y estado actual

Las features 1 a 5 construyeron todas las pantallas como HTML plano generado en el servidor, **sin hojas de estilo, sin JavaScript y sin una barra de navegación común**: cada área (agenda, panel de soporte, cuenta del paciente) pone una línea de enlaces arriba de su contenido. Todas las pantallas comparten una plantilla de página con el aviso de privacidad y el canal de derechos en el pie, y las páginas de error (403, 404, 500) usan un HTML mínimo propio. Hace poco se retiró el mapa incrustado de Google para no enviar datos de pacientes a un tercero; esta feature debe respetar el mismo criterio.

**Inventario de pantallas** (resultado de la auditoría; la lista completa se confirma en el plan):

| Tipo | Pantallas |
|---|---|
| Acceso | inicio de sesión, segundo factor, recuperar contraseña, alta del segundo factor, cambio de contraseña y de correo |
| Registro y estado | registro del médico, estado de su solicitud, avisos legales, derechos sobre los datos, aceptar avisos |
| Públicas del consultorio | micrositio, micrositio no disponible, entrada del paciente, primera cita, enlace de cita (3 pantallas) |
| Urgencias | formulario, sin espacio, alarma, captcha no disponible, llamar al consultorio, no disponible |
| Paciente con sesión | reservar, paciente adicional, mis citas, detalle de cita, mis consultorios, retirar consultorio |
| Médico y recepción | agenda del día y de la semana, nueva cita, detalle de cita, bloqueos, conflicto de bloqueo, configuración, mi micrositio, pacientes y detalle, recepción, cuenta (móvil de emergencia) |
| Soporte | resumen, médicos, detalle del médico, micrositios, cambio de enlace, correos, métricas, historial, liberar cédula |
| Errores | 403, 404, 500 |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Visitantes y pacientes ven un sitio profesional, claro y consistente (Priority: P1)

Una persona abre el enlace del consultorio, inicia sesión o crea su cuenta, reserva una cita, consulta sus citas o pide una urgencia. Todas esas pantallas comparten el mismo aspecto: tarjeta centrada para el acceso y las pantallas públicas, el nombre del consultorio y las acciones principales con jerarquía clara (un botón principal por pantalla), formularios legibles con errores visibles junto al campo, horarios fáciles de elegir y estados de cita con insignias de color y texto. En el celular se usa con una mano sin acercar el dedo a controles diminutos. Las pantallas de urgencia conservan o aumentan su énfasis: la indicación de **acudir a un hospital o llamar al consultorio** nunca queda menos visible que hoy.

**Why this priority**: es la primera impresión del consultorio ante el paciente y condiciona la confianza y la finalización de la reserva (meta del piloto: más del 70 %); además toca la mayoría de las pantallas.

**Independent Test**: recorrer el micrositio, el alta de paciente, la reserva, «mis citas» y el flujo de urgencia en un viewport de 390 px y en uno de 1440 px, y comprobar que todas muestran el diseño común, que se completa una reserva y una cancelación igual que antes, y que no hay desplazamiento horizontal de la página.

**Acceptance Scenarios**:

1. **Given** un micrositio publicado, **When** una persona sin sesión lo abre, **Then** ve una tarjeta centrada con el nombre del consultorio, la dirección con su enlace «Cómo llegar», el teléfono y las dos opciones de entrada, con el pie legal visible.
2. **Given** una pantalla de formulario con errores de validación, **When** el servidor responde con los mensajes de siempre, **Then** cada mensaje se ve con estilo de error junto a su campo o en un resumen superior, sin cambiar su texto.
3. **Given** el calendario de reserva con horarios libres y ocupados, **When** el paciente lo abre, **Then** puede distinguir libres de ocupados sin depender solo del color y elegir uno con el dedo.
4. **Given** la pantalla de urgencia (formulario, alarma o «sin espacio»), **When** se muestra, **Then** la instrucción de acudir a un hospital o llamar al consultorio es el elemento más destacado y las categorías de triaje se distinguen por texto además de color.
5. **Given** la lista «mis citas», **When** hay citas agendadas y canceladas, **Then** cada una lleva una insignia con el estado en texto y color, y la acción de cancelar se presenta como acción de peligro.
6. **Given** una persona con sesión (por ejemplo un paciente en la reserva, o el personal que revisa el micrositio) que abre una pantalla del consultorio, **When** se muestra, **Then** usa la estructura con la barra lateral de su rol; quien no tiene sesión ve la tarjeta centrada.

---

### User Story 2 - Médico y recepción trabajan la agenda en una interfaz ordenada (Priority: P2)

El médico y su recepción entran a la agenda y ven una estructura estable en todas sus pantallas: barra lateral en escritorio (arriba en el celular) con el nombre del producto, la navegación del área con la página actual resaltada y una tarjeta de la persona con su rol y el botón «Salir»; encabezado con la fecha y el título; contenido en tarjetas. La agenda del día, la semana, la nueva cita, el detalle, los bloqueos, la configuración, el micrositio, los pacientes y la cuenta usan los mismos botones, formularios, tablas e insignias. Si la cuenta está en solo lectura, el aviso se ve como una alerta clara arriba del contenido.

**Why this priority**: es el uso diario del piloto (el médico debe usar la agenda «por su cuenta» cada semana), pero depende de los componentes que se definen en la historia 1.

**Independent Test**: con una cuenta de médico y una de recepción, recorrer todas las pantallas del área en 1440 px y 390 px: la página actual aparece resaltada en la navegación, las tablas (si las hay) se desplazan dentro de su contenedor y todas las acciones existentes siguen funcionando.

**Acceptance Scenarios**:

1. **Given** una persona con sesión de médico, **When** abre cualquier pantalla del área, **Then** ve la barra lateral con el nombre del producto, los enlaces que hoy existen para su rol (agenda, bloqueos y, solo si puede, configuración), la página actual resaltada y su tarjeta de usuario con «Salir».
2. **Given** una cuenta en solo lectura, **When** abre su agenda, **Then** el aviso de solo lectura se ve como alerta informativa y las acciones que no puede hacer siguen sin ofrecerse o se rechazan como hoy.
3. **Given** la pantalla de bloqueos o la lista de citas del día, **When** hay más columnas de las que caben en 390 px, **Then** la tabla se desplaza horizontalmente dentro de su contenedor y la página no.
4. **Given** el detalle de una cita agendada, **When** el médico la cancela, **Then** el botón de cancelar se ve como acción de peligro y pide la misma confirmación que hoy.

---

### User Story 3 - Soporte opera el panel con el mismo sistema visual (Priority: P3)

La persona de soporte usa el panel (`/soporte`) con la barra lateral de su área, tablas de médicos, micrositios, correos e historial legibles, métricas con su meta y una insignia «cumple / no cumple», y formularios de acción (motivo + confirmación) con la advertencia de no escribir datos personales bien visible. Los estados del médico y de los correos se leen en un vistazo gracias a las insignias.

**Why this priority**: es un público de 1 a 2 personas durante el piloto; el valor es la consistencia y la legibilidad, no la primera impresión.

**Independent Test**: con una cuenta de soporte con segundo factor, abrir cada pantalla del panel en 1440 px y 390 px y comprobar el diseño común, la navegación con la página actual resaltada y que ninguna tabla desborda la página.

**Acceptance Scenarios**:

1. **Given** la lista de médicos, **When** soporte la abre, **Then** cada médico muestra su estado de aprobación y de cuenta como insignias con texto, y el enlace al detalle es claramente accionable.
2. **Given** una acción de cambio de estado, **When** soporte abre el formulario, **Then** el motivo, la casilla de confirmación y la advertencia de datos personales se ven agrupados y el botón de la acción se presenta como acción de peligro cuando corresponde.
3. **Given** la pantalla de métricas, **When** se abre, **Then** cada métrica muestra su cifra, su meta y su estado (cumple, no cumple, sin datos) sin depender solo del color.

---

### User Story 4 - Accesibilidad y uso en celular en todas las pantallas (Priority: P2)

Cualquier persona, con teclado, lector de pantalla o celular, puede usar todas las pantallas. Los textos tienen contraste suficiente, todos los campos tienen su etiqueta, el foco es visible, las áreas táctiles son cómodas, la información no depende solo del color y las animaciones respetan la preferencia de «reducir movimiento».

**Why this priority**: es un requisito transversal de calidad y de inclusión (un consultorio atiende a personas mayores y a quien tiene prisa por un dolor); se verifica contra todas las historias anteriores.

**Independent Test**: recorrer con teclado cada tipo de pantalla comprobando foco visible y orden; revisar el contraste de las combinaciones de color definidas; probar con 390 px de ancho y con la preferencia de reducir movimiento activada.

**Acceptance Scenarios**:

1. **Given** cualquier pantalla con formulario, **When** se navega con la tecla Tab, **Then** cada control muestra un foco visible y el orden coincide con el visual.
2. **Given** cualquier texto del sistema, **When** se mide su contraste con el fondo, **Then** es de al menos 4.5:1 (3:1 para texto grande).
3. **Given** un viewport de 390 px, **When** se abre cualquier pantalla, **Then** no hay desplazamiento horizontal de la página y los botones, campos y enlaces de acción miden al menos 44 px de alto.
4. **Given** la preferencia del sistema «reducir movimiento», **When** se abre cualquier pantalla, **Then** no hay transiciones ni animaciones.

---

### Edge Cases

- **Textos largos**: un nombre de médico o paciente muy largo, o una dirección de 300 caracteres, no rompe la maqueta ni desborda su tarjeta.
- **Tablas anchas** (historial, correos, lista de médicos): se desplazan dentro de su contenedor en celular y la página no.
- **Sin carga de la tipografía elegida** (si falla o tarda): el texto es legible desde el primer momento con una fuente de respaldo y no «salta» de forma molesta.
- **Navegador sin soporte de alguna propiedad visual moderna**: la pantalla sigue siendo usable aunque se vea más simple.
- **Páginas de error** (403, 404, 500, formulario vencido): usan el diseño común y mantienen su mensaje sin detalles internos.
- **Páginas con sesión a medias** (segundo factor pendiente, avisos legales por aceptar): muestran el mismo diseño y el botón «Salir».
- **Sesión no iniciada en una pantalla de sesión**: nunca se muestra la tarjeta de usuario ni «Salir» a quien no tiene sesión.
- **Colores de las categorías de triaje**: son contenido médico con significado propio; se conservan distinguibles pero dentro del sistema de color (y con texto, no solo color).
- **Pantallas muy cortas** (error 404): la tarjeta queda centrada y el pie legal al fondo.
- **Impresión**: fuera de alcance; no se garantiza un formato de impresión.
- **Zoom del 200 % y letra grande del sistema**: el contenido sigue usable sin pérdida de funciones.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Toda pantalla HTML del sitio, incluidas las páginas de error, MUST presentar el sistema visual común; no puede quedar ninguna pantalla sin estilo. Una pantalla nueva que use la plantilla común lo hereda sin trabajo adicional.
- **FR-002**: El sistema MUST definir en **un solo lugar** su paleta (primario verde azulado, menta, cielo, ámbar, rojo, textos, fondos y bordes), su tipografía, sus radios y su escala de espaciado; ninguna pantalla puede fijar colores propios fuera de esa definición. Los valores de referencia son los del documento de diseño aportado (primario `#0B7A72`, texto `#0F2A2E`, fondo `#F4F8F8`, etc.).
- **FR-003**: La tipografía MUST usar una fuente de títulos y otra de cuerpo con la escala del documento de referencia (título de página 30 px, sección 16–18 px, cuerpo 14 px, etiqueta 13 px) y MUST mostrar horas, fechas y teléfonos con cifras de ancho uniforme.
- **FR-004**: Las pantallas **con sesión** (médico, recepción, soporte, paciente) MUST tener una estructura común: barra lateral en escritorio y barra superior en celular con el nombre del producto «Agenda Dental», la navegación del área y una tarjeta de la persona con su rol (Médico, Recepción, Paciente o Soporte) y el botón «Salir». No se muestra nombre ni correo: no forman parte de la sesión y mostrar menos datos personales en pantalla es coherente con la constitución (decisión del plan, 26/11/2026). Las pantallas **sin sesión** MUST usar una tarjeta centrada.
- **FR-005**: La navegación MUST contener solo enlaces a pantallas que hoy existen para ese rol, MUST resaltar la página actual (también para tecnologías de apoyo) y MUST NOT añadir secciones nuevas (por ejemplo «Pacientes», «Doctores» o «Reportes» como menú si hoy no existen como tal). Con la sesión a medias (segundo factor pendiente o avisos legales por aceptar) la barra no muestra navegación, solo el nombre del producto, el rol y «Salir», porque sus enlaces redirigirían.
- **FR-006**: Los botones y enlaces con aspecto de botón MUST tener tres variantes (primario, secundario, de peligro), estado deshabilitado y una altura táctil mínima de 44 px. Cada pantalla MUST tener como máximo un botón primario por formulario; cancelar una cita, suspender una cuenta, quitar un logo y similares MUST presentarse como acción de peligro.
- **FR-007**: Los formularios MUST mostrar etiqueta asociada a cada campo, foco visible, campos agrupados por tema cuando la pantalla los tiene, y los mensajes de error existentes con estilo de error junto al campo o en un resumen, sin alterar su texto.
- **FR-008**: Las tablas y listas anchas MUST desplazarse horizontalmente **dentro de su contenedor**; la página MUST NOT desbordar en ningún ancho de 390 px a 1440 px.
- **FR-009**: Los estados que la app muestra hoy MUST presentarse como insignias de texto y color con estas cinco variantes: confirmada (menta), en curso o informativa (cielo), pendiente o por revisar (ámbar), cancelada o fallida (rojo) y neutra (gris). Mapeo inicial: cita agendada → confirmada; cita cancelada → cancelada; médico aprobado, micrositio publicado, correo enviado, métrica que cumple → confirmada; médico pendiente, micrositio en borrador, correo pendiente → pendiente; médico rechazado o suspendido, correo fallido, métrica que no cumple → cancelada; solo lectura → informativa; sin datos o despublicado → neutra.
- **FR-010**: Los avisos existentes (solo lectura, confirmaciones y errores de acciones, advertencia de datos personales en soporte, avisos del flujo de urgencia) MUST presentarse con cuatro variantes (informativo, éxito, advertencia, error) con ícono o texto que no dependa solo del color. Los avisos de seguridad del paciente en urgencias (acudir a un hospital, llamar al consultorio) MUST ser siempre el elemento más prominente de su pantalla.
- **FR-011**: Las listas sin elementos («no tienes citas», «sin correos fallidos», etc.) MUST mostrar un estado vacío con mensaje claro y, si hoy existe, el botón de la acción relacionada; no se crean acciones nuevas.
- **FR-012**: Las secciones de cada pantalla MUST agruparse en tarjetas o paneles con título, y la información de resumen (detalle de cita, de médico, métricas) MUST presentarse como lista de pares etiqueta-valor legible.
- **FR-013**: Todas las pantallas MUST ser utilizables entre 390 px y 1440 px de ancho, sin desbordamiento horizontal de la página y con controles de al menos 44 px de alto.
- **FR-014**: Accesibilidad: el contraste de texto MUST ser de al menos 4.5:1 en todas las combinaciones del sistema; todo control MUST tener etiqueta o nombre accesible; el foco MUST ser visible en todo elemento interactivo; la información MUST NOT transmitirse solo con color; y las transiciones MUST desactivarse con la preferencia «reducir movimiento».
- **FR-015**: **Sin cambios funcionales**: rutas, métodos, nombres de campos, validaciones, textos legales y de triaje, avisos y flujo de navegación MUST permanecer idénticos. Los cambios al marcado MUST ser los mínimos (clases, contenedores de maqueta y etiquetas que falten).
- **FR-016**: Privacidad: el navegador de la persona usuaria MUST NOT solicitar ningún recurso (estilos, fuentes, imágenes, scripts) a dominios de terceros en ninguna pantalla; todo recurso del diseño se sirve desde el propio sitio. La tipografía de marca (Inter para el cuerpo y Manrope para los títulos) se aloja **en el propio servidor** (decisión de la persona responsable, 26/11/2026): fidelidad exacta al diseño en cualquier equipo, sin enviar datos del paciente a un proveedor de fuentes, con licencia libre y dentro del presupuesto de peso de SC-006. Si un archivo de fuente no carga, el texto se muestra con una fuente del sistema de respaldo.
- **FR-017**: Las cabeceras de seguridad actuales MUST mantenerse; solo se pueden ampliar lo mínimo necesario para servir los estilos y fuentes propios, **sin** permitir estilos en línea nuevos ni orígenes externos. Las pantallas con datos MUST seguir sin guardarse en caché; los recursos estáticos del diseño pueden cachearse.
- **FR-018**: El botón «Salir» MUST aparecer en la estructura común (tarjeta de usuario) de toda pantalla con sesión, también en las de sesión a medias (segundo factor o avisos pendientes), y MUST NOT aparecer para quien no tiene sesión.
- **FR-019**: El pie con el aviso de privacidad y el canal de derechos MUST seguir presente en todas las pantallas.
- **FR-020**: Debe existir una verificación automática que recorra las pantallas y compruebe que cada una carga la hoja de estilos común, que no hay colores fuera de la definición central ni estilos en línea nuevos, y que los controles tienen etiqueta; y una revisión visual documentada (capturas a 390 px y a 1440 px de cada tipo de pantalla).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de las pantallas del inventario (incluidas las de error) se muestran con el diseño común; verificado con un recorrido automático y una revisión visual de cada tipo.
- **SC-002**: A 390 px y a 1440 px de ancho, 0 pantallas presentan desplazamiento horizontal de la página.
- **SC-003**: El 100 % de las combinaciones de texto y fondo del sistema alcanzan un contraste de al menos 4.5:1 (3:1 en texto grande), y el 100 % de los controles de acción miden al menos 44 px de alto.
- **SC-004**: La suite de pruebas existente pasa sin regresiones funcionales; solo cambian las aserciones que dependían de la estructura exacta del marcado, sin cambiar el comportamiento que verifican.
- **SC-005**: Al cargar cualquier pantalla, 0 peticiones del navegador a dominios que no sean el propio sitio.
- **SC-006**: Los recursos de diseño (hoja de estilos y fuentes) suman menos de 300 KB y el micrositio y el calendario siguen mostrándose en menos de 2 segundos con conexión normal (SC-008 de la feature 3).
- **SC-007**: Una persona nueva completa una primera reserva en el micrositio en menos de 2 minutos (meta del piloto, SC-001 de la feature 3) con el diseño nuevo, igual o mejor que antes.
- **SC-008**: Todas las acciones de todos los formularios se pueden completar solo con teclado, con foco visible en cada paso, verificado en el 100 % de los tipos de formulario.

## Assumptions

- La referencia visual es el documento «Spec de diseño — Agenda Dental» que aportó la persona responsable; se toman sus colores, tipografía, radios, espaciado, componentes y reglas de accesibilidad, **solo en lo que aplica a lo que ya existe**.
- **Fuera de alcance**: campana de notificaciones, buscador de encabezado, mini calendario, tarjeta «Siguiente paciente», métricas nuevas en la agenda, secciones de menú nuevas, modo oscuro, internacionalización, formato de impresión, nuevas pantallas o funciones, WhatsApp, cobro e historial clínico.
- El nombre del producto en la cabecera es «Agenda Dental»; el nombre oficial de la empresa (WATA GROUP) se mantiene en los documentos y correos donde ya aparece y no se agrega a las pantallas.
- Hoy una cita solo puede estar «agendada» o «cancelada» (no existen los estados «en consulta» ni «por confirmar» del documento de referencia); el mapeo de insignias del FR-009 usa solo los estados existentes y deja las demás variantes para futuros usos.
- Íconos: los necesarios son pocos (logo, navegación, alertas) y se resuelven con dibujos vectoriales propios incluidos en el sitio, sin librerías externas ni fuentes de íconos.
- El sitio no usa JavaScript y esta feature no lo introduce; la barra lateral y el menú del celular se resuelven sin él.
- Los colores de las categorías de triaje (feature 4) se conservan como colores del sistema con significado propio; ajustarlos al contenido médico requiere la validación del dentista, así que no se cambian los textos ni el orden, solo su presentación.
- El diseño se aplica una sola vez en la plantilla común y en unas pocas estructuras compartidas; no se rediseña la lógica de cada pantalla.
- Las pruebas existentes que comparan fragmentos de HTML pueden necesitar ajustes de aserciones por el nuevo marcado; eso no cuenta como cambio funcional.
- Se despliega en el mismo hosting (feature en producción en `agendadental.innvend.com`), y los recursos estáticos del diseño forman parte del despliegue.
- **Limitación conocida**: la sesión no incluye el estado de aprobación del médico, así que un médico aún no aprobado o suspendido ve la navegación completa del médico; sus enlaces dan el 403 o la pantalla de estado de siempre, ya con el diseño común. Evitarlo exigiría una consulta por página y queda fuera de esta feature.
- En la tabla de triaje (feature 4) el campo `color` pasa a un valor `tone` (1 a 5) que elige el color dentro del sistema; es un cambio de presentación que no altera el texto, el orden ni las categorías sujetas a la validación del dentista.
