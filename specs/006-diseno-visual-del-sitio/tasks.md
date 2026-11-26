---

description: "Lista de tareas de la feature 006-diseno-visual-del-sitio"
---

# Tasks: Diseño visual del sitio

**Input**: Documentos de diseño en `/specs/006-diseno-visual-del-sitio/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS. La constitución (principio V) exige pruebas junto con la implementación. Aquí son de **contrato** (estructura de las pantallas, recursos), **unitarias** (contraste y mapeos de estado) y de **guardia** (sin colores sueltos, sin `style=`, sin URLs externas, peso máximo). La verificación visual a 390 px y 1440 px es **manual** y se documenta (no hay navegador automatizado en el proyecto). La suite existente debe seguir verde en cada corte; solo se ajustan aserciones atadas a la estructura del marcado, nunca el comportamiento que verifican.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US4 de `spec.md`). La fase 2 (cimientos) bloquea a todas; US4 (accesibilidad) se ejecuta al final porque revisa las pantallas ya estilizadas.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- **Sin cambios funcionales** (FR-015): no se tocan rutas, métodos, nombres de campos de formularios, validaciones, textos legales ni de triaje, ni el flujo de navegación. Cambios de marcado mínimos (clases, contenedores de maqueta, etiquetas que falten).
- **Sin colores literales** (`#hex`, `rgb()`, `hsl()`) fuera de `:root` de `src/http/assets/styles.css`, y **sin `style=`** en el código de las vistas (FR-002, FR-017).
- **Cero recursos de terceros** (FR-016): ni `<link>`, ni fuentes, ni íconos, ni scripts externos; sin JavaScript nuevo.
- Sin `any` salvo justificación en comentario; sin `console.log`; sin dependencias nuevas (las fuentes se copian de un `npm pack` temporal, sin instalarlas ni tocar `package.json` ni el lockfile).
- El texto del usuario sigue escapándose con `html` (como hoy); los ayudantes nuevos devuelven `SafeHtml`.
- Los textos de estado y de error que la app ya muestra **no cambian**; las insignias y alertas los envuelven.
- Las pruebas de integración y de contrato se ejecutan por PowerShell con ruta `C:\…` (ver memoria del proyecto).
- Precondición: los cambios pendientes de las features 3 y «Salir» (enlace «Cómo llegar», arranque sin `await`, botón «Salir») van en sus propios commits **antes** de empezar.

---

## Phase 1: Setup

- [ ] T001 Obtener las fuentes sin instalar dependencias: en un directorio temporal fuera del repositorio ejecutar `npm pack @fontsource-variable/inter` y `npm pack @fontsource-variable/manrope`, extraer los `.woff2` **variables del subconjunto latino** y copiarlos a `src/http/assets/fonts/inter-var-latin.woff2` y `src/http/assets/fonts/manrope-var-latin.woff2`; crear `src/http/assets/fonts/LICENSES.md` con la licencia SIL OFL 1.1 de ambas, la versión de origen y los pesos cubiertos (Inter 400–700, Manrope 600–800). Comprobar que suman menos de ~100 KB y que `package.json` y `package-lock.json` no cambiaron (`git status`).
- [ ] T002 [P] Actualizar `scripts/copy-assets.mjs` para copiar también `src/http/assets` a `dist/src/http/assets` (junto a la lista de contraseñas comunes); comprobar con `npm run build` que `dist/src/http/assets/fonts/*.woff2` existe.

---

## Phase 2: Foundational (bloquea a todas las historias)

**Purpose**: el sistema visual, la ruta de recursos, la CSP, la plantilla y el shell. Sin esto ninguna pantalla puede estilizarse.

### Pruebas primero (deben fallar antes de implementar)

- [ ] T003 [P] Escribir `tests/unit/design-guards.test.ts`: (a) en `src/http/assets/styles.css` ningún color literal (`#hex`, `rgb(`, `hsl(`) fuera del bloque `:root`; (b) ningún `style=` en `src/http/views/**/*.ts`, `src/modules/**/*.ts` ni `src/http/app.ts`; (c) ninguna URL `http(s)://` a dominios externos en la hoja, las vistas ni la plantilla (se permite `https://www.google.com/maps/search/` del enlace «Cómo llegar»); (d) `styles.css` + las dos fuentes pesan menos de 300 KB (SC-006).
- [ ] T004 [P] Escribir `tests/unit/design-tokens.test.ts`: leer `:root` de `styles.css`, calcular el contraste de **todas** las parejas texto/fondo del sistema listadas en la prueba (texto sobre fondo, texto sobre superficie, muted sobre fondo, blanco sobre primario, `--color-primary-strong` sobre menta, `*-text` de cielo/ámbar/rojo sobre su fondo, texto de cada `--triage-n` sobre su fondo) y exigir ≥ 4.5:1 (3:1 en texto grande); y probar los mapeos puros de `data-model.md` §3 (`appointmentBadge`, `doctorApprovalBadge`, `doctorAccountBadge`, `siteBadge`, `mailBadge`, `metricBadge`: variante y texto de cada estado).
- [ ] T005 [P] Escribir `tests/contract/assets-routes.test.ts`: `GET /assets/styles.css` y las dos fuentes responden 200 con `content-type` fijo, `cache-control: public, max-age=31536000, immutable` y `x-content-type-options: nosniff`; `HEAD` funciona; nombres fuera de la lista (`/assets/otro.css`, `/assets/fonts/x.woff2`, `/assets/../package.json`, `/assets/%2e%2e/`, subdirectorios) dan **404 idéntico** al de una ruta inexistente; la petición 601 en un minuto desde la misma IP recibe 429 y otra IP no se ve afectada; la cabecera `content-security-policy` de una página HTML se comprueba completa: contiene las directivas de `contracts/assets-and-components.md` (entre ellas `style-src 'self'` y `font-src 'self'`) y ninguna lleva `https:` ni `unsafe-inline`; las respuestas de `/assets/` no llevan `cache-control: no-store`.
- [ ] T006 [P] Escribir `tests/contract/design-shell.test.ts` (el recorrido se arma **enumerando todas las rutas `GET` registradas** con la opción `onRoute` de `createTestApp`, como ya hace `tests/integration/route-audit.test.ts`: cada ruta debe estar en el recorrido —con parámetros de muestra y sesión por rol con `sessionFor`— o en una lista explícita de excepciones que no son pantallas (logo, cédula, `/assets/*`, respuestas JSON); si aparece una ruta `GET` nueva sin clasificar, la prueba falla, de modo que ninguna pantalla pueda quedar sin diseño, SC-001): toda pantalla HTML enlaza **un** `/assets/styles.css?v=…`, tiene `lang="es"`, viewport, `noindex`, «Saltar al contenido», `<main id="contenido">` y el pie legal (la regla de un solo `<h1>` se verifica en T044, cuando todas las pantallas ya están convertidas); **sin sesión** usa `card-page` y no contiene `action="/logout"`, `user-card` ni `sidebar`; **con sesión** de cada rol hay `aside.sidebar` con `nav[aria-label="Principal"]` con las entradas de `data-model.md` §4 (recepción **sin** Configuración), una sola entrada con `aria-current="page"` según la ruta (ninguna en `/cuenta/...`), la tarjeta de usuario con la etiqueta de rol y el formulario `POST /logout` con el `_csrf` de la sesión; con sesión a medias (segundo factor o avisos legales pendientes) solo hay logo, tarjeta de usuario y «Salir», **sin navegación**; una cuenta en solo lectura muestra `.alert--info[role=status]`; las páginas 404 y 403 usan el diseño común; las pantallas del consultorio que abre una persona con sesión (por ejemplo `/c/:slug/reservar` de un paciente) usan la barra de su rol, y sin sesión la tarjeta centrada.

### Implementación

- [ ] T007 Crear `src/http/assets/styles.css` — **tokens y base** (FR-002, FR-003, FR-014): `:root` con todos los tokens de `data-model.md` §1 (incluidos `--triage-1…5` con su color de texto, elegidos para cumplir contraste, y los compuestos como el fondo de hover de la navegación), `@font-face` de Inter y Manrope (`font-display: swap`, `src: url(/assets/fonts/…)`), reglas base (`box-sizing`, `body`, enlaces, `h1`/`h2`, `font-variant-numeric: tabular-nums` aplicado a `body` (cubre horas, fechas y teléfonos, FR-003), foco visible `--focus-ring` en todo interactivo) y `@media (prefers-reduced-motion: reduce)` que desactiva transiciones.
- [ ] T008 Ampliar `src/http/assets/styles.css` — **estructura** (FR-004, FR-013): `.card-page` (tarjeta centrada de 400 px máx., logo arriba), `.has-shell`/`.app` (`display:flex; flex-wrap:wrap; min-height:100vh`), `.sidebar` (`flex: 1 1 248px`, borde derecho, columna, tarjeta de usuario al fondo), `.main` (`flex: 999 1 560px; min-width: 0`), navegación (`nav a` 44 px, activo con `aria-current="page"`/`.is-active`), `.skip-link`, y responsive: con menos de 800 px la barra pasa arriba y la navegación es una fila con desplazamiento horizontal **dentro de su contenedor**; sin desborde horizontal de la página entre 390 y 1440 px.
- [ ] T009 Ampliar `src/http/assets/styles.css` — **componentes** (FR-006 a FR-012, FR-014): botones sobre el elemento desnudo (primario por defecto) más `.btn`, `.btn-secondary`, `.btn-danger`, deshabilitado, altura 44 px; `input`/`select`/`textarea`/`label`/`fieldset`/`legend` sin clase; `ul.errors`/`.field-error`; `.chip` (+ `aria-pressed`, `.is-selected`); `.table-wrap` con `overflow-x:auto` y `table` (encabezado 12 px en mayúsculas, hover de fila, sin cebra); `.badge` y sus cinco variantes con punto; `.alert` con cuatro variantes y `.alert--prominent`; `.card` con cabecera; `dl`; `.empty`; `.triage` y `.triage--1…5` (borde izquierdo y texto de la categoría).
- [ ] T010 Crear `src/http/asset-url.ts` (lee `styles.css` y las fuentes **relativo al propio módulo** con `new URL("./assets/", import.meta.url)`, de modo que funcione igual desde `src/` —pruebas y desarrollo— y desde `dist/` —producción, tras `copy-assets`—, calcula el hash corto de cada archivo y exporta `assetUrl(name)` con `?v=<hash>`) y `src/http/assets-routes.ts` según `contracts/assets-and-components.md`: sirve los archivos que leyó `asset-url.ts`, lista cerrada de nombres, `GET`/`HEAD`, `Content-Type` fijo, `Cache-Control` de un año `immutable`, `nosniff`, límite de peticiones propio de 600 por minuto por IP y 404 uniforme (el mismo `NotFoundError`) para todo lo demás. Registrar la ruta en `src/compose.ts` junto a las demás. T005 debe pasar.
- [ ] T011 Endurecer la CSP en `src/http/app.ts`: configurar `helmet` con las directivas de `contracts/assets-and-components.md` (`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`) con `useDefaults: true`: se sobrescriben solo las directivas listadas y se conserva el valor por defecto de las demás (incluida `upgrade-insecure-requests`, sin cambiar el comportamiento actual en desarrollo y pruebas) y de las demás cabeceras de `helmet`; en el valor final ninguna directiva lleva `https:` ni `unsafe-inline`.
- [ ] T012 [P] Crear `src/http/views/icons.ts`: logo (diente) e íconos de trazo en línea (`stroke="currentColor"`, `fill="none"`, 18 px, `aria-hidden="true"`) para agenda, bloqueos, ajustes, micrositio, recepción, inicio, citas, consultorios, médicos, correos, métricas, historial, salir, y los de alerta (info, éxito, advertencia, error); `icon(name)` devuelve `SafeHtml`.
- [ ] T013 Crear `src/http/views/ui.ts`: `badge`, `alert`, `card`, `tableWrap`, `emptyState`, `definitionList` (contratos de `assets-and-components.md`) y los mapeos puros `appointmentBadge`, `doctorApprovalBadge`, `doctorAccountBadge`, `siteBadge`, `mailBadge`, `metricBadge` con la tabla de `data-model.md` §3. T004 (mapeos) debe pasar.
- [ ] T014 Actualizar `src/http/views/layout.ts` (FR-001, FR-019): `<head>` con `lang="es"`, viewport, `noindex`, `<link rel="stylesheet" href=assetUrl(styles.css)>` (con `assetUrl` de `src/http/asset-url.ts`, no del módulo de rutas) y la precarga de las dos fuentes; «Saltar al contenido» como primer elemento; marcas `<!--shell:open-->`/`<!--shell:close-->` alrededor de `<main id="contenido">` y del pie legal; **misma firma** `page({ title, content })`. El `<body>` sale como `card-page` (el gancho lo cambia con sesión).
- [ ] T015 Crear `src/http/shell.ts` según `contracts/ui-shell.md`: tabla de navegación por rol (`data-model.md` §4) y etiquetas de rol, cálculo de la entrada activa por prefijo más largo, y gancho `onSend` que, en respuestas `text/html` con las marcas, arma **sin sesión** la tarjeta centrada y **con sesión** `aside.sidebar` + `.main` con logo y nombre «Agenda Dental», navegación del rol (solo con sesión completa: con sesión a medias —segundo factor o avisos pendientes— se omite la navegación porque sus enlaces redirigirían) y tarjeta de usuario con el rol y el formulario `POST /logout` con el `_csrf` de la sesión (`sessionCsrfToken`), y la alerta informativa de solo lectura cuando `accountStateOf(request) === "read_only"` (mismo texto de hoy, `role="status"`). Sin estilos en línea, sin consultas a la base y sin tocar `Cache-Control`.
- [ ] T016 Cablear en `src/http/app.ts`: registrar el gancho del shell y **retirar** el `onSend` de «Salir» (`<nav aria-label="Sesión">`) y el del aviso de solo lectura que reemplazaba `<main>`; las páginas de error (`sendError`) pasan a generarse con `page()` para heredar el diseño (mismos mensajes, sin detalles internos).
- [ ] T017 [P] Actualizar `src/http/views/forms.ts` (FR-007): `textInput`, `passwordInput`, `checkbox`, `fileInput`, `submitButton` y `form` emiten etiqueta asociada, el bloque de errores como `ul.errors[role=alert]`/`.field-error` junto al campo, y el botón de envío primario; mismos `name`, `id` y textos.
- [ ] T018 Ajustar las pruebas existentes atadas al marcado retirado: `tests/contract/logout-button.test.ts` (el formulario de «Salir» ahora está en la tarjeta de usuario, no en un `<nav>` arriba), las que comprueban el párrafo del aviso de solo lectura, y cualquier aserción sobre `<nav aria-label="Agenda">` o `<nav aria-label="Panel de soporte">` (hoy ninguna; confirmar con `Grep`). T003, T004, T005 y T006 deben pasar al terminar la fase.
- [ ] T019 Punto de control de la fase 2: `npm run lint`, `npm run typecheck` y la suite completa en verde; abrir `/login` y una página de error y comprobar a mano que ya tienen el diseño. Commit: «Añade el sistema visual, los recursos propios y la estructura común».

**Checkpoint**: sistema visual y estructura listos; cualquier pantalla que use `page()` ya hereda el diseño.

---

## Phase 3: User Story 1 - Visitantes y pacientes ven un sitio profesional, claro y consistente (Priority: P1) 🎯 MVP

**Goal**: las pantallas de acceso, registro, legales, públicas del consultorio, urgencias y del paciente con sesión usan el diseño común con jerarquía clara, errores visibles, horarios distinguibles, insignias de cita y urgencias con la instrucción de hospital como elemento principal.

**Independent Test**: recorrer micrositio, alta de paciente, reserva, «mis citas» y flujo de urgencia a 390 y 1440 px; todas muestran el diseño, se completa una reserva y una cancelación igual que antes y no hay desplazamiento horizontal.

### Pruebas primero

- [ ] T020 [P] [US1] Escribir `tests/contract/design-us1.test.ts`: las pantallas públicas y de acceso (`/login`, `/recuperar`, `/legal`, `/derechos`, `/pacientes/registro`, `/medicos/registro`, `/c/:slug`, `/c/:slug/entrar`, `/c/:slug/primera-cita`, enlace de cita no válido) usan `card-page`; el calendario de reserva marca cada horario con texto o `aria` que distingue libre de ocupado y los libres miden como control táctil (clase de botón/chip); «mis citas» muestra `badge--confirmed` «Agendada» y `badge--cancelled` «Cancelada» y el botón de cancelar con `btn-danger`; la lista vacía de «mis citas» usa `.empty`; las pantallas de urgencia contienen `alert--prominent` con la instrucción de acudir a un hospital o llamar al consultorio, y las cinco categorías de triaje salen con `triage--1…5` **y** su texto, sin `style=`; los mensajes de error de formularios conservan su texto.

### Implementación

- [ ] T021 [P] [US1] Acceso en `src/modules/auth/routes.ts`, `src/modules/auth/recovery-routes.ts`, `src/modules/auth/account-routes.ts` y `src/modules/auth/mfa-routes.ts`: usar los ayudantes y clases (`alert` para avisos y errores, `fieldset`/`legend` donde hay grupos, `btn-secondary` en acciones secundarias, `btn-danger` en las destructivas como desactivar el doble factor), sin cambiar rutas, campos ni textos.
- [ ] T022 [P] [US1] Registro y avisos en `src/modules/doctors/registration-routes.ts`, `src/modules/doctors/status-routes.ts` y `src/modules/legal/routes.ts`: mismo tratamiento; los textos legales conservan su contenido y se muestran dentro de `card` con tipografía legible; casillas de aceptación con su etiqueta.
- [ ] T023 [P] [US1] Paciente en `src/modules/patients/routes.ts` (registro y panel): `card`, `emptyState`, botones con variantes.
- [ ] T024 [US1] Pantallas públicas de `src/http/views/site.ts`: `publicSitePage`, `unavailableSitePage`, `entryPage`, `firstAppointmentPage`, `appointmentLinkGonePage`, `appointmentLinkLoginPage`, `appointmentLinkSummaryPage` con tarjeta centrada, dirección con el enlace «Cómo llegar» como botón secundario con ícono, teléfono con cifras uniformes y las dos opciones de entrada (una primaria).
- [ ] T025 [US1] Reserva en `src/http/views/site.ts`: `bookingPage` (horarios como botones/chips de 44 px; libre vs ocupado distinguibles por texto o `aria` además del color y el ocupado deshabilitado y tachado; selector de día/mes legible) y `additionalPatientPage`. Misma lógica de selección y mismos campos.
- [ ] T026 [US1] Citas del paciente en `src/http/views/site.ts`: `myAppointmentsPage` (insignia por `appointmentBadge`, `tableWrap` si usa tabla, `emptyState`), `patientAppointmentPage` (`definitionList`, cancelar con `btn-danger`), `myOfficesPage` y `revokeOfficePage` (acción de retirar como `btn-danger`).
- [ ] T027 [US1] Urgencias en `src/http/views/urgent.ts`: `urgentFormPage` con las categorías como opciones con clase `.triage--<id>` y su texto (se **elimina** el `style="border-left…"` de la línea 50; en `src/modules/urgent/triage-content.ts` el campo `color` (hex) se reemplaza por `tone` (1 a 5), que elige la clase `.triage--<tone>`, y se actualiza `tests/unit/triage-content.test.ts:33` para validar `tone`; **no cambian** el texto, el orden ni las categorías, y el cambio se anota en el ADR 0007 como de presentación, no de contenido, para no afectar la validación pendiente del dentista); `noSpacePage`, `alarmPage`, `callOfficePage`, `captchaUnavailablePage` y `urgentUnavailablePage` con `alert--prominent` para la instrucción de acudir a un hospital o llamar al consultorio.
- [ ] T028 [US1] Ajustar las pruebas existentes que dependan del marcado de estas pantallas (`tests/contract/site-public.test.ts`, de reserva y de urgencias, y las de registro/acceso) sin cambiar lo que verifican.
- [ ] T029 [US1] Punto de control: lint, typecheck, suite completa, T006 y T020 en verde; recorrido manual del escenario 1 a 4 de `quickstart.md`. Commit: «Aplica el diseño a las pantallas de acceso, públicas y del paciente».

**Checkpoint**: US1 completa y demostrable de forma independiente (es el MVP visible para el paciente).

---

## Phase 4: User Story 2 - Médico y recepción trabajan la agenda en una interfaz ordenada (Priority: P2)

**Goal**: la agenda, nueva cita, detalle, bloqueos, configuración, micrositio, pacientes, recepción y cuenta usan el diseño común con la navegación del rol y la página activa resaltada.

**Independent Test**: con una cuenta de médico y una de recepción, recorrer todas las pantallas del área a 1440 y 390 px: página actual resaltada, tablas dentro de su contenedor, aviso de solo lectura como alerta y todas las acciones funcionando como antes.

### Pruebas primero

- [ ] T030 [P] [US2] Escribir `tests/contract/design-us2.test.ts`: las pantallas de `/agenda`, `/agenda/dia/:fecha`, `/agenda/semana/:fecha`, `/agenda/citas/nueva`, `/agenda/citas/:id`, `/agenda/bloqueos`, `/agenda/configuracion`, `/medicos/micrositio`, `/medicos/recepcion`, `/medicos/inicio`, `/recepcion/panel` y `/cuenta/movil-emergencia` ya no contienen el `<nav aria-label="Agenda">` propio y sí la barra del shell con la entrada activa correcta; toda `<table>` está dentro de `.table-wrap`; la cita agendada lleva `badge--confirmed`; cancelar y quitar bloqueo/logo usan `btn-danger`; el formulario de configuración agrupa campos con `fieldset`/`legend`; en solo lectura aparece `.alert--info`; recepción no ve «Configuración».

### Implementación

- [ ] T031 [US2] `src/http/views/calendar.ts` — estructura: `calendarLayout` deja de emitir el `<nav aria-label="Agenda">` (la navegación la da el shell; se conserva el parámetro `canConfigure` solo si otros llamadores lo pasan, sin usarlo) y el contenido se agrupa en `card`.
- [ ] T032 [US2] `src/http/views/calendar.ts` — agenda: `dayPage`, `weekPage` con `tableWrap`, cifras uniformes en horas, `appointmentBadge`, `emptyState` para días sin citas y botones de bloquear/quitar bloqueo como secundario/`btn-danger`.
- [ ] T033 [US2] `src/http/views/calendar.ts` — formularios y detalle: `newAppointmentPage` (grupos con `fieldset`/`legend`, selector de horarios como chips, errores junto al campo), `appointmentDetailPage` (`definitionList`, insignia de estado, cancelar con `btn-danger`), `blocksPage`, `blockConflictPage` (alerta de advertencia) y `configurationPage` (secciones con `fieldset`, barra de acciones al final: cancelar secundario y guardar primario).
- [ ] T034 [US2] `src/http/views/site.ts` — `doctorSitePage` («Mi micrositio»): `siteBadge` del estado, pasos pendientes como `alert--warning`, publicar primario, despublicar y quitar logo como `btn-danger`/secundario, el enlace del micrositio con botón de copiar solo como enlace (sin JavaScript).
- [ ] T035 [P] [US2] Rutas con HTML en línea del médico y recepción: `src/modules/patients/detail-routes.ts` (detalle de paciente: `definitionList`, tabla envuelta), `src/modules/reception/routes.ts` (invitación, panel, médico activo: `card`, `alert`, botones), `src/modules/doctors/account-routes.ts` (móvil de emergencia) y la pantalla de inicio del médico en `src/modules/doctors/status-routes.ts`.
- [ ] T036 [US2] Ajustar las pruebas existentes de agenda, bloqueos, configuración, micrositio y recepción que dependan del marcado, sin cambiar lo que verifican.
- [ ] T037 [US2] Punto de control: lint, typecheck, suite completa, T006 y T030 en verde; recorrido manual de los escenarios 5 y 6 de `quickstart.md`. Commit: «Aplica el diseño a la agenda del médico y de recepción».

**Checkpoint**: US1 y US2 funcionan de forma independiente.

---

## Phase 5: User Story 3 - Soporte opera el panel con el mismo sistema visual (Priority: P3)

**Goal**: el panel de soporte usa el shell de su rol, tablas y formularios legibles, insignias de estado y métricas con «cumple / no cumple».

**Independent Test**: con una cuenta de soporte con segundo factor, abrir cada pantalla del panel a 1440 y 390 px: diseño común, navegación con la página activa y ninguna tabla desborda la página.

### Pruebas primero

- [ ] T038 [P] [US3] Escribir `tests/contract/design-us3.test.ts`: las pantallas de `/soporte`, `/soporte/medicos`, `/soporte/medicos/:id`, `/soporte/micrositios`, `/soporte/correos`, `/soporte/metricas`, `/soporte/historial` y `/soporte/medicos/:id/liberar-cedula` no contienen el `<nav aria-label="Panel de soporte">` propio y sí la barra del shell con la entrada activa; la lista de médicos muestra las insignias de aprobación y de cuenta; toda tabla está en `.table-wrap`; las métricas muestran `badge--confirmed|cancelled|neutral` con «Cumple», «No cumple» o «Sin datos»; los formularios de acción agrupan motivo, casilla y la advertencia de datos personales como `alert--warning`; los textos de las pruebas existentes de soporte (por ejemplo «✓ sin señales») siguen presentes.

### Implementación

- [ ] T039 [US3] `src/modules/support/support-views.ts`: `supportPage` deja de añadir su `nav()` (se retira la función y su tabla `NAV`, que pasa a `shell.ts` sin duplicarse), `errorNotice` usa `alert` de error, `REASON_WARNING` se muestra como `alert--warning`, y `actionForm` agrupa motivo, casilla y botón con `btn-danger` cuando la acción es de cambio de estado.
- [ ] T040 [US3] `src/modules/support/support-views.ts` (misma pasada, tablas y estados): `doctorListView`, `doctorDetailView`, `sitesView`, `slugFormView`, `mailView`, `metricsView`, `historyView` y `releaseView` con `tableWrap` en sus 10 tablas/listas, `doctorApprovalBadge`/`doctorAccountBadge`/`siteBadge`/`mailBadge`/`metricBadge`, `definitionList` en el detalle y paginación del historial como botones de 40 px; ningún dato nuevo y ninguna consulta nueva (soporte sigue sin ver datos de pacientes); las listas vacías (sin médicos, sin correos fallidos, historial vacío) usan `emptyState` (FR-011).
- [ ] T041 [P] [US3] Revisar `src/modules/support/support-routes.ts` (HTML en línea, por ejemplo el enlace a `/soporte/correos`) y alinearlo con `ui.ts`.
- [ ] T042 [US3] Ajustar las pruebas existentes de soporte (`tests/contract/support-*.test.ts`) que dependan del marcado, sin cambiar lo que verifican, y confirmar que `support-isolation.test.ts` sigue verde.
- [ ] T043 [US3] Punto de control: lint, typecheck, suite completa, T006 y T038 en verde; recorrido manual del escenario 7 de `quickstart.md`. Commit: «Aplica el diseño al panel de soporte».

**Checkpoint**: las tres áreas funcionales usan el mismo sistema visual.

---

## Phase 6: User Story 4 - Accesibilidad y uso en celular en todas las pantallas (Priority: P2, transversal; se ejecuta al final)

**Goal**: teclado, lector de pantalla y celular funcionan en todas las pantallas.

**Independent Test**: recorrer con Tab un ejemplar de cada tipo de pantalla; contrastes ≥ 4.5:1; 390 px sin desborde; con «reducir movimiento» sin transiciones.

- [ ] T044 [P] [US4] Escribir `tests/contract/design-a11y.test.ts`: recorrer la misma lista de pantallas de T006/T020/T030/T038 y comprobar que todo `input`/`select`/`textarea` tiene `label` asociado (`for`/`id`, envolvente) o `aria-label`, que todo `button` y enlace de acción tiene texto o `aria-label`, que cada `<th>` lleva `scope="col"`, que toda imagen tiene `alt`, que hay un solo `h1`, que los botones de solo ícono tienen `aria-label` y que `styles.css` contiene `@media (prefers-reduced-motion: reduce)` y la regla de foco visible.
- [ ] T045 [US4] Corregir lo que T044 y la revisión revelen en las vistas (etiquetas faltantes, encabezados repetidos, enlaces sin texto), con cambios de marcado mínimos.
- [ ] T046 [US4] Revisión manual con teclado y con 390 px y 1440 px de un ejemplar de cada tipo de pantalla (acceso, públicas, urgencias, paciente, médico, recepción, soporte, error) y con «reducir movimiento»; registrar el resultado y las capturas (sin datos reales de pacientes) en `docs/design-review.md`. Corregir hallazgos de contraste, tamaño táctil o desborde en `styles.css`.

---

## Phase 7: Polish y despliegue

- [ ] T047 [P] Documentar: `docs/decisions/0007-diseno-visual.md` (decisiones de `research.md`, tokens, ruta de recursos, CSP, riesgos abiertos: `style=` olvidado dejaría de aplicarse, LiteSpeed con `.woff2`), `docs/configuration.md` (sección de diseño: `/assets`, caché larga, cómo cambiar un token), y notas de cambio en `specs/003-micrositio-y-reserva-del-paciente/spec.md` y `specs/005-panel-de-soporte/spec.md` donde se describía la navegación propia.
- [ ] T048 Revisión independiente antes de dar la feature por terminada: `code-review` y `/security-review` sobre el diff (con atención a la lista cerrada de recursos y al 404 uniforme, la CSP, el token CSRF del botón «Salir» solo con sesión, que el shell no filtre datos entre usuarios, y que no se pierda ninguna casilla de aceptación ni texto legal), verificando cada hallazgo antes de aplicarlo; documentar el resultado.
- [ ] T049 Verificación final de la definición de terminado: `npm run lint`, `npm run typecheck`, `npm run test` completos; sin `console.log`; sin secretos; las guardias T003 verdes; la spec refleja lo implementado (marcar cumplidos los criterios y actualizar la sección de supuestos si cambió algo).
- [ ] T050 **(manual)** Desplegar con el procedimiento actual (`hosting_deploy` con el directorio de despliegue limpio, ver memoria) y comprobar en `agendadental.innvend.com`: `/assets/styles.css` y las dos fuentes responden 200 con caché larga, la CSP vigente es la de `contracts/assets-and-components.md`, **ninguna petición sale del dominio** (pestaña de red), y repetir los escenarios 1, 2 y 11 de `quickstart.md` con una cuenta de prueba; medir una primera reserva de principio a fin (meta: menos de 2 minutos, SC-007) y la carga del micrositio y del calendario (meta: menos de 2 segundos, SC-006). Commit final y actualización de la memoria del proyecto.

---

## Dependencias y orden de ejecución

- **Fase 1** (T001–T002): sin dependencias; T002 en paralelo.
- **Fase 2** (T003–T019): depende de la fase 1. Pruebas T003–T006 primero (fallan); luego T007→T008→T009 (misma hoja, en orden), T010 y T011 después de T007–T009; T012 y T013 en paralelo; T014 depende de T010; T015 de T013–T014; T016 de T015; T017 en paralelo con T012; T018 y T019 cierran. **Bloquea a todas las historias.**
- **US1** (T020–T029) → **US2** (T030–T037) → **US3** (T038–T043): independientes entre sí tras la fase 2 (se pueden hacer en cualquier orden o en paralelo si hay dos personas), pero **comparten `site.ts`** (T024–T026 y T034) y **`calendar.ts`** (T031–T033), así que dentro de cada archivo van en orden.
- **US4** (T044–T046): después de US1–US3 (revisa las pantallas ya estilizadas).
- **Polish** (T047–T050): al final; T048 antes de T050.

## Oportunidades de paralelismo

- Fase 2: T003, T004, T005 y T006 (cuatro archivos de prueba); T012 con T013; T017 con T012.
- US1: T021, T022 y T023 (archivos de rutas distintos); `site.ts` y `urgent.ts` en otra línea.
- US2: T035 con T031–T034 (archivos distintos).
- US3: T041 con T039–T040.
- US4/Polish: T044 con T047.

## Estrategia de implementación

- **MVP**: Fase 1 + Fase 2 + US1 (T001–T029). Con eso el paciente ya ve el sitio con el diseño, y cualquier pantalla pendiente de otras áreas ya hereda tarjeta, tipografía y botones por el estilo base.
- **Incremental**: un commit por corte (fase 2, US1, US2, US3) con la suite verde; se puede desplegar tras cualquier corte.
- **Riesgo principal**: la CSP estricta deja sin efecto cualquier `style=` o recurso externo olvidado; por eso las guardias T003 y la revisión visual T046 son parte de la definición de terminado.
