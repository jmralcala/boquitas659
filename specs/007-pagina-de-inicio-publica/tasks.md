---

description: "Lista de tareas de la feature 007-pagina-de-inicio-publica"
---

# Tasks: Página de inicio pública

**Input**: Documentos de diseño en `/specs/007-pagina-de-inicio-publica/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS (constitución, principio V). Pruebas de contrato (contenido, destinos, redirección por rol, sin formularios ni terceros), una prueba unitaria de **veracidad del texto** (términos prohibidos y lista de capacidades) y el ajuste de la auditoría de rutas y del recorrido de pantallas de la feature 6. Se escriben primero y deben fallar antes de implementar. La verificación visual a 390 y 1440 px es manual.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US4 de `spec.md`). Toda la portada vive en **una sola vista y una sola ruta**, así que las tareas de una misma historia comparten archivo y van en orden.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- **No cambiar** el registro de médicos, el inicio de sesión ni ninguna pantalla existente, sus rutas, métodos o campos (FR-016). La portada solo añade `GET /`.
- **Sin colores literales** (`#hex`, `rgb()`) fuera de `:root` de `src/http/assets/styles.css`, **sin `style=`**, **sin `<script>`**, **sin URLs `http(s)` externas** y sin dependencias nuevas; las guardias de la feature 6 (`tests/unit/design-guards.test.ts`) deben seguir en verde.
- **Veracidad (FR-009)**: los textos son los de [contracts/page-content.md](contracts/page-content.md), sin añadir frases. Nada de reprogramar, WhatsApp/mensajería, rentabilidad, precios, resultados ni urgencias en línea.
- La portada **no emite las marcas del shell** (`<!--shell:open/close-->`) ni usa `page()`: no lleva barra lateral ni «Salir».
- Sin cookies, sin analítica, sin formularios ni campos (FR-015, FR-001).
- Sin `any`; sin `console.log`; el correo y el año se escapan con `html` como el resto de vistas.
- Las pruebas de contrato se ejecutan por PowerShell con ruta `C:\…`; **no correr dos corridas de vitest a la vez** (comparten la base de pruebas).

---

## Phase 1: Setup

- [x] T001 Extraer de `src/http/views/layout.ts` la función exportada `documentHead(options: { title: string; description?: string })` que devuelve el `<head>` común (`<meta charset>`, viewport, `<meta name="robots" content="noindex">`, `<title>` escapado, descripción opcional `<meta name="description" content="…">` escapada, precarga de las dos fuentes y `<link rel="stylesheet" href=stylesheetUrl()>`), y hacer que `page()` la use **sin cambiar su salida** (misma cadena de siempre cuando no hay descripción). Comprobar con `tests/contract/design-shell.test.ts` y `tests/unit/views.test.ts`.
- [x] T002 [P] Añadir a `src/http/views/icons.ts` cinco íconos de trazo (mismas reglas que los existentes: `PATHS` y `icon(name)`, `aria-hidden`): `timer` (`<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>`), `bell` (`<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 004 0"/>`), `shield` (`<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>`), `arrow-right` (`<path d="M5 12h14M13 6l6 6-6 6"/>`) y `log-in` (`<path d="M15 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M10 8l4 4-4 4M14 12H3"/>`).

---

## Phase 2: Foundational (pruebas primero y estilos; bloquean a las historias)

- [x] T003 [P] Escribir `tests/contract/landing.test.ts` (debe fallar: la raíz aún no existe). Un `describe` por historia, con `createTestApp`, `sessionFor`, `createPatient`, `createDoctor`, `createUser` y `createSupportWithMfa`:
  - **US1**: `GET /` sin sesión responde 200 `text/html`; contiene los textos de `contracts/page-content.md` (`h1` con «Tu consultorio, en orden.» y «Tus pacientes, a un mensaje de distancia.», el párrafo principal, el `h2` de beneficios, las 5 tarjetas, el `h2` y el texto de la banda); exactamente 3 enlaces a `/medicos/registro` con textos «Registrarme», «Regístrate aquí» y «Regístrate aquí»; sin `<form` ni `<input` ni `<script` ni `style=`; sin URLs `http(s)` externas; `<meta name="robots" content="noindex">`; `<title>` y descripción de la spec.
  - **US2**: exactamente 2 enlaces a `/login` («Iniciar sesión» y «Ya tengo cuenta»); con sesión completa de paciente, médico, recepción y soporte responde 303 a `/pacientes/panel`, `/medicos/inicio`, `/recepcion/panel` y `/soporte/medicos`; con la sesión a medias (`sessions.create(id, { mfaVerified: false })` de un soporte con doble factor) responde 200 con la portada; con avisos legales pendientes (publicar una versión nueva del aviso de privacidad de pacientes que la cuenta no ha aceptado) una sesión de paciente recibe **303 a `/legal/aceptar`** en lugar de la redirección a su área (filtro global, ver `contracts/http-routes.md`); `HEAD /` responde 200 sin cuerpo y con las mismas cabeceras.
  - **US3**: un solo `<h1`; regiones `<header`, `<main id="contenido">` y `<footer`; «Saltar al contenido» primero; todos los íconos `aria-hidden="true"`; sin `class="has-shell"`, sin `<aside`, sin `action="/logout"`; sin `Set-Cookie`; `Cache-Control: no-store`; el HTML pesa menos de 30 KB.
  - **US4**: el pie contiene `href="/legal/doctor_privacy"` («Aviso de privacidad»), `href="/legal/terms_doctor"` («Términos y condiciones») y `href="mailto:soporte@innvend.com"` («Contacto»); el año del pie es el del reloj de pruebas (`t.clock.set(new Date("2026-11-26T…"))` → «© 2026 Agenda Dental»); con `RIGHTS_CONTACT_EMAIL` distinto (`createTestApp(pool, { RIGHTS_CONTACT_EMAIL: "otro@example.com" })`) el `mailto:` cambia y se escapa.
- [x] T004 [P] Escribir `tests/unit/landing-copy.test.ts` (debe fallar): renderizar `landingPage({ year: 2026, contactEmail: "soporte@innvend.com" })` (importado de `src/http/views/landing.js`), extraer el **texto visible** (quitar `<svg>…</svg>`, etiquetas, `<head>`) en minúsculas sin acentos y comprobar que **no** contiene ninguno de los términos prohibidos de `contracts/page-content.md` (`reprogram`, `whatsapp`, `mensajer`, `rentabil`, `ganancia`, `ingreso`, `precio`, `costo`, `gratis`, `descuento`, `oferta`, `garant`, `satisfech`, `testimonio`, `lider`, las palabras completas `plan` y `planes` —con límite de palabra, para que «planear» no falle— y ningún `%`), que contiene las frases de la lista de capacidades (las 5 tarjetas y el párrafo principal, textuales) y que el HTML completo pesa menos de 30 KB.
- [x] T005 [P] Actualizar `tests/integration/route-audit.test.ts`: añadir `"specs/007-pagina-de-inicio-publica/contracts/http-routes.md"` a `CONTRACT_FILES` y `"/"` al conjunto `PUBLIC_GET` (la raíz es pública y responde sin sesión).
- [x] T006 [P] Actualizar `tests/contract/design-shell.test.ts`: en `expectDesigned`, aceptar como pie legal `href="/legal"` **o** `href="/legal/doctor_privacy"` (la portada tiene su propio pie), y en el recorrido de rutas conservar todos los demás chequeos (hoja, `lang`, viewport, `noindex`, «Saltar al contenido», `<main id="contenido">`, sin `style=`, sin marcas del shell).
- [x] T007 Ampliar `src/http/assets/styles.css` con los estilos de la portada, **solo con tokens de `:root`** y sin colores nuevos (si hiciera falta un tono, se añade el token y su contraste se agrega a `tests/unit/design-tokens.test.ts`): `.landing` (fondo `--color-bg`), `.topbar` (blanco, borde inferior, contenido centrado `max-width: 1200px`, flex con `justify-content: space-between`, alto mínimo 72 px), `.topbar nav` (flex, `gap`), `.hero` (padding vertical amplio, `max-width: 1200px`), `.hero__tag` (etiqueta en `--color-mint`/`--color-primary-strong`, pill), `.hero h1` (Manrope 800, `clamp(32px, 5vw, 56px)`, la segunda línea en `--color-primary` con `.hero__accent`), `.hero__lead` (`--color-text-muted`, `max-width: 640px`), `.hero__actions` (flex con `flex-wrap` y `gap`), `.benefits` (fondo `--color-surface`, bordes arriba y abajo), `.features` (`display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; list-style: none; padding: 0`), `.feature` (tarjeta con borde, radio `--radius-xl`, ícono en cuadro `--color-mint`), `.cta-band` (fondo `--color-primary`, texto `--color-on-primary`, radio `--radius-xl`, flex que se apila en celular), `.btn-light` (botón blanco: fondo `--color-surface`, texto `--color-primary-strong`), `.landing-footer` (flex con `justify-content: space-between` y `flex-wrap`, borde superior). En `@media (max-width: 807px)`: barra con `flex-wrap`, botones del hero a ancho completo, banda en columna. Todos los botones y enlaces de acción ≥ 44 px (`--control-h`).

**Checkpoint**: pruebas escritas (fallan por ahora), íconos, `documentHead` y estilos listos.

---

## Phase 3: User Story 1 - Un médico conoce el servicio y empieza su registro (Priority: P1) 🎯 MVP

**Goal**: la raíz muestra la portada completa y los tres botones de registro llevan al registro de médicos.

**Independent Test**: abrir `/` sin sesión → ver barra, sección principal, 5 tarjetas y banda; los 3 enlaces de registro abren `/medicos/registro`; sin formularios.

- [x] T008 [US1] Crear `src/http/views/landing.ts` con `landingPage(options: { year: number; contactEmail: string }): string`: documento HTML **propio** (no `page()`): `<!doctype html><html lang="es">`, `documentHead({ title: "Agenda Dental: agenda en línea para consultorios dentales", description: <la de page-content.md> })`, `<body class="landing">`, «Saltar al contenido» (`a.skip-link` a `#contenido`) y **sin** `SHELL_OPEN/SHELL_CLOSE`. Bloques en este orden y con los textos **exactos** de `contracts/page-content.md` y `data-model.md`: `<header class="topbar">` (enlace logo + «Agenda Dental» a `/` con `logo()`, `<nav aria-label="Principal">` con «Registrarme» → `/medicos/registro` y botón `a.btn.btn-secondary` «Iniciar sesión» con `icon("log-in")` → `/login`); `<main id="contenido">` con `section.hero` (etiqueta, `<h1>` de dos líneas con la segunda en `span.hero__accent`, párrafo principal con «Agenda Dental» en `<strong>`, y dos botones: `a.btn` «Regístrate aquí» + `icon("arrow-right")` → `/medicos/registro` y `a.btn.btn-secondary` «Ya tengo cuenta» → `/login`), `section.benefits` (`<h2>`, introducción y `<ul class="features">` con las 5 tarjetas `li.feature` y sus íconos `calendar`, `success`, `timer`, `bell`, `shield`), `section.cta-band` (`<h2>`, texto y `a.btn.btn-light` «Regístrate aquí» → `/medicos/registro`). Todo con la etiqueta `html` (escape por defecto), sin `style=`. El pie lo añade T015 (US4).
- [x] T009 [US1] Crear `src/modules/home/home-routes.ts` con `registerHomeRoutes(app, services)`: `GET /` con `config.rateLimit` de 120 por minuto, que responde `reply.type("text/html; charset=utf-8").send(landingPage({ year: services.clock.now().getUTCFullYear(), contactEmail: services.env.RIGHTS_CONTACT_EMAIL }))`; no lee query ni cuerpo. Registrarla en `src/compose.ts` junto a las demás (`registerHomeRoutes(app, services)`).
- [x] T010 [US1] Punto de control: `npx tsc --noEmit`, `npx eslint src tests` y las pruebas del bloque US1 de `landing.test.ts`, más `tests/unit/landing-copy.test.ts` (que no prueba el pie: el pie lo prueba solo el bloque US4 de `landing.test.ts`) y `tests/unit/design-guards.test.ts`, en verde.

**Checkpoint**: US1 completa; la portada ya se ve y los botones de registro funcionan.

---

## Phase 4: User Story 2 - Quien ya tiene cuenta entra sin buscar el enlace (Priority: P1)

**Goal**: «Iniciar sesión» y «Ya tengo cuenta» van a `/login`; quien ya tiene sesión es redirigido a su área.

**Independent Test**: los 2 enlaces abren `/login`; con sesión completa de cada rol, `/` responde 303 al inicio del rol; con la sesión a medias se ve la portada.

- [x] T011 [US2] En `src/modules/home/home-routes.ts`: antes de pintar la portada, si `isFullyAuthenticated(request.auth)` responder `reply.redirect(HOME_BY_ROLE[request.auth.role], 303)` (importar `isFullyAuthenticated` de `../../http/session-plugin.js` y `HOME_BY_ROLE` de `../auth/routes.js`, la misma tabla que usa `/login`); con la sesión a medias o sin sesión, la portada. Sin consultas a la base. Los dos enlaces a `/login` ya los emite T008.
- [x] T012 [US2] Punto de control: el bloque US2 de `landing.test.ts` en verde (2 enlaces a `/login`, 4 redirecciones por rol, sesión a medias muestra la portada); `tests/integration/route-audit.test.ts` en verde.

**Checkpoint**: US1 y US2 funcionan.

---

## Phase 5: User Story 3 - Se lee bien en el celular y es accesible (Priority: P2)

**Goal**: sin desbordes de 390 a 1440 px, controles táctiles, un solo `h1`, regiones y foco; sin cookies ni terceros.

**Independent Test**: la portada a 390 y 1440 px sin desplazamiento horizontal; Tab recorre con foco visible; un solo `h1`; el bloque US3 de `landing.test.ts` en verde.

- [x] T013 [US3] Revisar y completar en `src/http/assets/styles.css` (bloque de la portada) el comportamiento adaptable: `@media (max-width: 807px)` apila las 5 tarjetas (una columna) y deja los botones del hero a ancho completo; el titular usa `clamp()` y se parte sin desbordar; el contenedor tiene `max-width` y `padding` lateral de 16 px en celular; `min-height: var(--control-h)` en todos los botones y enlaces de la barra y del pie; el foco visible hereda de la regla global; ninguna regla de la portada introduce color literal. Si cambia algún par de colores, agregar su contraste a `tests/unit/design-tokens.test.ts`.
- [x] T014 [US3] Revisar en `src/http/views/landing.ts` la semántica de accesibilidad: un solo `<h1>` (las dos líneas dentro del mismo `h1`), `<h2>` para beneficios y banda, `header`/`main`/`footer`, `aria-label` en `nav`, todos los íconos con `aria-hidden` (los emite `icon()`/`logo()`), el enlace del logo con texto («Agenda Dental»), y que los dos «Regístrate aquí» conserven nombre y destino. Punto de control: `tests/contract/design-a11y.test.ts`, `tests/contract/design-shell.test.ts` y el bloque US3 de `landing.test.ts` en verde.

**Checkpoint**: US1 a US3 completas.

---

## Phase 6: User Story 4 - Contacto y textos legales a la vista (Priority: P3)

**Goal**: pie con año en curso, aviso de privacidad, términos y contacto por correo.

**Independent Test**: los tres enlaces del pie van a sus destinos y el año es el del reloj.

- [x] T015 [US4] Añadir a `landingPage` en `src/http/views/landing.ts` el `<footer class="landing-footer">`: «© {year} Agenda Dental» y tres enlaces — «Aviso de privacidad» → `/legal/doctor_privacy`, «Términos y condiciones» → `/legal/terms_doctor`, «Contacto» → `mailto:{contactEmail}` (valor escapado por `html`; con `title="Escribir a {contactEmail}"` para poder copiar la dirección si no hay cliente de correo). Punto de control: el bloque US4 de `landing.test.ts` y `tests/unit/landing-copy.test.ts` completos en verde.

**Checkpoint**: las cuatro historias completas.

---

## Phase 7: Polish y despliegue

- [x] T016 [P] Documentar: `docs/decisions/0008-pagina-de-inicio.md` (decisiones de `research.md`: vista propia sin shell, ruta con redirección, texto veraz y su prueba, sin indexar durante el piloto, sin caché, año en UTC, filtros globales; riesgos abiertos: el registro lo ve cualquiera aunque soporte aprueba a mano, y **dependencia aceptada**: mientras los textos legales de médico sean provisionales el registro en producción responde con su aviso de «revisión legal»; la portada se publica igual y el registro se abre cuando un abogado los revise y se publiquen), una nota en `docs/configuration.md` (sin variables nuevas; la portada usa `RIGHTS_CONTACT_EMAIL`) y una nota en `specs/006-diseno-visual-del-sitio/spec.md` aclarando que la portada tiene su propio pie (FR-019).
- [x] T017 Revisión independiente antes de dar la feature por terminada: `code-review` y `/security-review` (por ejemplo con un subagente de solo lectura) sobre el diff, con atención a que la raíz no lea entrada, que el correo de contacto se escape, que no se establezca ninguna cookie, que la redirección no permita redirecciones abiertas, y a que ninguna frase prometa lo que el piloto no tiene; verificar cada hallazgo antes de aplicarlo.
- [ ] T018 Verificación final de la definición de terminado: `npm run lint`, `npm run typecheck` y `npm run test` completos (la suite completa tarda ~70 minutos; no lanzar dos corridas a la vez); sin `console.log`; sin secretos; la spec refleja lo implementado (marcar criterios cumplidos). Commit: «Añade la página de inicio pública».
- [ ] T019 **(manual)** Desplegar con el procedimiento actual (`hosting_deploy` con el directorio de despliegue limpio) y comprobar en `agendadental.innvend.com`: `/` responde 200 con la portada; los 3 enlaces de registro abren `/medicos/registro`; los 2 de acceso abren `/login`; con la sesión iniciada la raíz redirige al área del rol; los enlaces del pie funcionan; ninguna petición sale del dominio y no se establece ninguna cookie; medir la carga (meta: menos de 2 s). Repetir el escenario 1 de `quickstart.md` a 390 px y 1440 px **y el recorrido con teclado** (Tab con foco visible en cada enlace y botón, orden lógico y «Saltar al contenido», SC-008) y registrar el resultado. Comprobar además que el formulario de registro, mientras los textos de médico sean provisionales, responde con el aviso de «revisión legal» (dependencia aceptada) y no con un error técnico.
- [x] T020 Actualizar la memoria del proyecto con el estado de la feature 7 y push a GitHub.

---

## Dependencias y orden de ejecución

- **Fase 1** (T001, T002): sin dependencias; T002 en paralelo con T001.
- **Fase 2** (T003–T007): depende de la fase 1 solo para T007 y T008; las pruebas T003 a T006 son independientes entre sí ([P]); T007 puede ir en paralelo con ellas. **Bloquea a las historias.**
- **US1** (T008→T009→T010): T008 y T009 tocan archivos distintos pero T009 importa la vista, así que T008 va antes.
- **US2** (T011, T012): depende de US1 (misma ruta).
- **US3** (T013, T014): depende de US1; T013 (CSS) y T014 (vista) tocan archivos distintos y pueden ir en paralelo si no hay otro cambio en `landing.ts`.
- **US4** (T015): depende de T008 (misma vista).
- **Polish** (T016–T020): al final; T017 antes de T018; T019 después de T018.

## Oportunidades de paralelismo

- Fase 1: T001 con T002.
- Fase 2: T003, T004, T005 y T006 (cuatro archivos de prueba) y T007 (CSS).
- Fase 5: T013 (CSS) con T014 (vista).
- Fase 7: T016 (documentación) con T017 (revisión).

## Estrategia de implementación

- **MVP**: Fases 1 y 2 + US1 (T001–T010): la raíz ya muestra la portada y los botones de registro funcionan.
- **Incremental**: US2 añade el acceso y la redirección; US3 pule lo adaptable y accesible; US4 añade el pie. Un solo commit al final, con la suite verde.
- **Riesgo principal**: que un texto vuelva a prometer lo que el piloto no tiene; por eso T004 (términos prohibidos y capacidades) es parte de la definición de terminado.
