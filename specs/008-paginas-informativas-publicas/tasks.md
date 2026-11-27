---

description: "Lista de tareas de la feature 008-paginas-informativas-publicas"
---

# Tasks: Páginas informativas públicas (Cómo funciona, Planes y Nosotros)

**Input**: Documentos de diseño en `/specs/008-paginas-informativas-publicas/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: OBLIGATORIOS (constitución, principio V). Pruebas unitarias de **cálculo de precios** y de **veracidad del texto**, pruebas de contrato por página (contenido, destinos, barra idéntica, sin formularios ni terceros, públicas para todos los roles) y ajustes a las auditorías existentes. Se escriben **antes** de la vista que las cumple y deben fallar primero.

**Organization**: Tareas agrupadas por historia de usuario (US1 a US5 de `spec.md`). Las historias comparten el marco público (Fase 2); cada página es una vista propia, pero las tres comparten `src/modules/home/info-routes.ts`, `src/http/assets/styles.css` y `tests/contract/info-pages.test.ts`, así que esas tareas van en orden.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de usuario a la que pertenece
- Todas las rutas son relativas a la raíz del repositorio (proyecto único, ver plan.md)

## Reglas transversales (aplican a TODAS las tareas)

- **No cambiar** el registro de médicos, el inicio de sesión, el cobro ni ninguna pantalla con sesión, sus rutas, métodos o campos (FR-024). Solo se añaden tres rutas `GET`, el marco compartido y sus pruebas; la portada solo cambia su barra.
- **Sin colores literales** (`#hex`, `rgb()`) fuera de `:root` de `src/http/assets/styles.css`, **sin `style=`**, **sin `<script>`**, **sin formularios**, **sin cookies**, sin dependencias nuevas y sin ampliar la CSP. Las guardias de la feature 6 (`tests/unit/design-guards.test.ts`) deben seguir en verde.
- **Textos literales** de [contracts/page-content.md](contracts/page-content.md); no añadir frases ni afirmar nada que no esté en la lista de capacidades del piloto (FR-009). Nada de reprogramación, rentabilidad, resultados, cobro, pago, urgencias en línea ni exceso por mensaje; WhatsApp solo en «Planes» y siempre con «Próximamente».
- **Montos sin centavos**: `$499`/`$349`, `$999`/`$699`, `$1,999`/`$1,399`; el precio con descuento se **calcula** de `plans.ts`, nunca se escribe a mano.
- Las páginas **no usan `page()`** ni emiten marcas del shell: usan el marco `publicDocument` (cuerpo `landing`), sin barra lateral ni «Salir».
- Sin `any`; sin `console.log`; año y correo de contacto se escapan con `html` como el resto de vistas.
- Las pruebas se ejecutan por PowerShell con ruta `C:\…`; **no correr dos corridas de vitest a la vez** (comparten la base de pruebas).

---

## Phase 1: Setup

- [x] T001 [P] Añadir a `src/http/views/icons.ts` dos íconos de trazo propios (mismas reglas: entrada en `PATHS`, `currentColor`, `aria-hidden`): `check` (`<path d="M5 12l4 4 10-10"/>`) y `phone` (`<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>`).
- [x] T002 [P] Crear `src/http/public-paths.ts` exportando `PUBLIC_INFO_PATHS: readonly string[] = ["/como-funciona", "/planes", "/nosotros"]` (comentario: páginas informativas visibles con o sin sesión; `/` no está incluida porque redirige).

**Checkpoint**: íconos y lista de rutas listos.

---

## Phase 2: Foundational (bloquea todas las historias)

**Purpose**: marco público compartido, exención de filtros y registro de rutas.

**⚠️ CRITICAL**: ninguna historia puede empezar sin el marco.

- [x] T003A Escribir primero (debe fallar) en `tests/contract/info-pages.test.ts` (créalo con el arranque de `createTestApp` y el helper `get`, como `landing.test.ts`) una prueba de la exención: un paciente con un aviso legal pendiente (`t.services.legal.publish` de una versión nueva de `patient_privacy`) abre `/como-funciona`, `/planes` y `/nosotros` y recibe **200 sin redirección** (hoy daría 303 a `/legal/aceptar`; con la ruta aún sin crear, 404), y `GET /` con esa misma sesión sigue dando 303 a `/legal/aceptar`; ídem soporte sin segundo factor activo (no se redirige a `/cuenta/mfa/alta`). Las rutas se crean en T009/T015/T024; esta prueba queda en rojo hasta entonces y se mantiene completa en T026. Antes de T003.
- [x] T003 Eximir `PUBLIC_INFO_PATHS` de los dos filtros globales: en `src/modules/legal/legal-gate.ts` y en `src/http/support-mfa.ts` añadir a `isExempt` la comprobación `PUBLIC_INFO_PATHS.includes(url)` (importar de `src/http/public-paths.ts`); `/` **no** se exime. Depende de T002.
- [x] T004 Crear `src/http/views/public-site.ts` con: tipo `MenuKey = "inicio" | "como-funciona" | "planes" | "nosotros"`; constante `MENU` (`label`, `href`, `key` de [data-model.md](data-model.md)); y `publicDocument(options: { current: MenuKey; title: string; description: string; main: SafeHtml; year: number; contactEmail: string }): string` que devuelve `<!doctype html>`, `<html lang="es">`, `documentHead({ title, description })`, `<body class="landing">`, «Saltar al contenido», la **barra única** (`<header class="topbar"><div class="topbar__inner">` con marca `<a class="brand" href="/">`, una sola `<nav aria-label="Principal">` con el grupo de menú `<ul class="topbar__menu">` —un `<li><a>` por entrada, `aria-current="page"` solo en la actual— y el grupo de acceso `<div class="topbar__actions">` con «Registrarme» (`/medicos/registro`) y el botón «Iniciar sesión» con `icon("log-in")` (`/login`)), `<main id="contenido">` con `main`, y el pie de la portada (`landing-footer` con «© {year} Agenda Dental», «Aviso de privacidad», «Términos y condiciones» y «Contacto» `mailto:` con `title`). Mismo marcado de marca y pie que hoy tiene `src/http/views/landing.ts`. Depende de T001.
- [x] T005 Crear `src/modules/home/info-routes.ts` con `registerInfoRoutes(app, services)` y el límite `INFO_RATE_LIMIT` (120 por minuto por IP, igual que `home-routes.ts`); por ahora sin rutas (cada historia añade la suya). Registrarlo en `src/compose.ts` junto a `registerHomeRoutes`. Sin lectura de sesión, de entrada ni de la base de datos.

**Checkpoint**: marco, exención y módulo de rutas listos; se pueden construir las páginas.

---

## Phase 3: User Story 1 - Cómo funciona (Priority: P1) 🎯 MVP

**Goal**: `/como-funciona` explica qué es Agenda Dental, beneficios, funcionalidades y pasos, solo con lo que el piloto tiene.

**Independent Test**: abrir `/como-funciona` sin sesión: las secciones están, cada afirmación es veraz y los botones finales llevan a `/medicos/registro` y `/login`.

### Tests for User Story 1 (escribirlos primero; deben fallar)

- [x] T006 [P] [US1] Crear `tests/unit/info-copy.test.ts` con el helper `visibleText(html)` (cuerpo + `<title>` + descripción, sin `<svg>` ni etiquetas, sin acentos, minúsculas, **sin la barra superior**) y, para «Cómo funciona», la comprobación de que **no** aparece ningún término de «Todas las páginas» ni de «Cómo funciona y Nosotros» de [contracts/page-content.md](contracts/page-content.md), y que **sí** aparecen las frases de capacidades (micrositio, sin dobles reservas, correo de confirmación, recepción, separados, Registro Nacional de Profesionistas).
- [x] T007 [P] [US1] Crear `tests/contract/info-pages.test.ts` (patrón de `landing.test.ts`: `createTestApp`, `get(url, cookie?)`, `linksTo`) con el bloque «US1» para `GET /como-funciona`: 200 `text/html`; título y descripción del contrato; un solo `<h1>` «Cómo funciona Agenda Dental»; los textos de «qué es»; las 6 tarjetas de beneficios con su título; las 9 funcionalidades; los 5 pasos del médico y los 4 del paciente; botones «Regístrate aquí» → `/medicos/registro` e «Iniciar sesión» → `/login` en la llamada final.

### Implementation for User Story 1

- [x] T008 [US1] Crear `src/http/views/how-it-works.ts` con `howItWorksPage(options: { year: number; contactEmail: string }): string` que arma el `<main>` (`page-hero` con etiqueta «Qué es», h1 y texto de «qué es»; sección «Beneficios para tu consultorio» con 6 tarjetas e íconos `calendar`, `success`, `users`, `bell`, `globe`, `shield`; «Lo que incluye» con lista `check`; «Para el médico» y «Para el paciente» como `<ol class="steps">`; banda final con los dos botones) y llama a `publicDocument({ current: "como-funciona", … })`. Textos literales del contrato. Depende de T004, T006 y T007.
- [x] T009 [US1] En `src/modules/home/info-routes.ts` añadir `GET /como-funciona` (con `INFO_RATE_LIMIT`; `reply.type("text/html; charset=utf-8").send(howItWorksPage({ year: services.clock.now().getUTCFullYear(), contactEmail: services.env.RIGHTS_CONTACT_EMAIL }))`). Depende de T005 y T008.
- [x] T010 [US1] Añadir a `src/http/assets/styles.css` (solo tokens de `:root`) los estilos de las páginas informativas: `.page-hero` (etiqueta, h1, texto), `.benefits-grid` (rejilla de tarjetas, 1 columna en celular y 3 desde ~900 px), `.info-section`, lista con `check` (`.checklist`), `ol.steps` numerada con contador, y la banda final reutilizando `.cta-band`. Sin colores literales.

**Checkpoint**: T006/T007 en verde; «Cómo funciona» funciona y es verificable sola.

---

## Phase 4: User Story 2 - Planes (Priority: P1)

**Goal**: `/planes` muestra Esencial, Profesional y Élite con precio original tachado, precio con descuento (sin centavos), «Próximamente» en WhatsApp, la promoción y la aclaración del cobro.

**Independent Test**: abrir `/planes`: seis montos correctos, leyendas de promoción, «Próximamente» y cobro; cada plan con «Regístrate aquí».

### Tests for User Story 2 (escribirlos primero; deben fallar)

- [x] T011 [P] [US2] Crear `tests/unit/plans.test.ts`: `DISCOUNT_PERCENT` es 30; `priceWithDiscount` da 349, 699 y 1399 para 499, 999 y 1999; para cualquier precio entero entre 1 y 5000 el resultado difiere del 70 % exacto en medio peso o menos y es menor que el original; `formatMxn(1399)` es `$1,399`, `formatMxn(499)` es `$499`, `formatMxn(0)` es `$0`; `PLANS` tiene 3 elementos en el orden Esencial, Profesional y Élite, con `trialDays` 5, `null` y `null`.
- [x] T012 [P] [US2] En `tests/unit/info-copy.test.ts` añadir «Planes»: sin términos de «Todas las páginas»; `whatsapp` solo dentro de un elemento marcado «Próximamente» o en la nota 3; el único `%` es «30 %»; no aparece «gratis», «oferta», «1 peso» ni «exceso»; aparecen la promoción de lanzamiento y la aclaración de que no hay cobro durante el piloto. Depende de T006.
- [x] T013 [US2] En `tests/contract/info-pages.test.ts` añadir el bloque «US2» para `GET /planes`: título, descripción y h1 del contrato; tres tarjetas en orden; por plan, el precio anterior dentro de `<del>` precedido de «Precio anterior:» y el precio con descuento precedido de «Precio con descuento:» (`$499`/`$349`, `$999`/`$699`, `$1,999`/`$1,399`), «al mes · IVA incluido», insignia «30 % de descuento», insignias «Próximamente» en los topes de WhatsApp, «Prueba de 5 días» (solo Esencial) y «Sin prueba» (los otros dos); las 4 notas; tres botones «Regístrate aquí» → `/medicos/registro` y ningún botón que sugiera pagar. Depende de T007.

### Implementation for User Story 2

- [x] T014 [US2] Crear `src/http/views/plans.ts` con `Plan`, `PLANS` (priceMxn 499, 999, 1999; `trialDays`; `whatsappAllowance`), `DISCOUNT_PERCENT = 30`, `priceWithDiscount(plan)` (`Math.floor((plan.priceMxn * (100 - DISCOUNT_PERCENT) + 50) / 100)`), `formatMxn(pesos)` (coma de miles, sin centavos) y `plansPage({ year, contactEmail })` que arma el `<main>` (h1 «Planes», introducción, `<ul class="plans">` con una tarjeta por plan, notas) y llama a `publicDocument({ current: "planes", … })`. Precio anterior en `<del>` con `<span class="visually-hidden">Precio anterior:</span>`; precio con descuento con `<span class="visually-hidden">Precio con descuento:</span>`; insignias `.badge` «30 % de descuento» y «Próximamente». Depende de T004, T011, T012 y T013.
- [x] T015 [US2] En `src/modules/home/info-routes.ts` añadir `GET /planes` igual que T009 con `plansPage`. Depende de T009 y T014.
- [x] T016 [US2] Añadir a `src/http/assets/styles.css` los estilos de planes (tokens de `:root`): `.plans` (rejilla: 1 columna en celular, 3 desde ~900 px), `.plan` (tarjeta), `.price__old` con `text-decoration: line-through` y color atenuado (el tachado, no solo el color, lo distingue), `.price__now` grande, `.badge` y `.badge--soon`, `.plan__list` con `check`, `.notes`. Depende de T010.

**Checkpoint**: T011–T013 en verde; «Planes» funciona y es verificable sola.

---

## Phase 5: User Story 4 - Barra de menú única (Priority: P1)

**Goal**: la portada y las tres páginas comparten la misma barra, con la página actual marcada y utilizable en celular sin JavaScript.

**Independent Test**: abrir las cuatro páginas: barra idéntica salvo `aria-current`; a 390 px se acomoda sin desbordar.

### Tests for User Story 4 (escribirlos primero; deben fallar)

- [x] T017 [P] [US4] En `tests/contract/info-pages.test.ts` añadir el bloque «US4»: extraer `<nav aria-label="Principal">…</nav>` de `/`, `/como-funciona`, `/planes` y `/nosotros`; quitar `aria-current="page"` y comprobar que las cuatro barras son **idénticas**; que cada página marca **solo** su propio enlace; los destinos y el orden (marca, Inicio, Cómo funciona, Planes, Nosotros, Registrarme, Iniciar sesión); que no hay ninguna otra `<nav>` principal ni formulario. Depende de T007.
- [x] T018 [P] [US4] Actualizar `tests/contract/landing.test.ts`: los conteos de enlaces (3 a `/medicos/registro`, 2 a `/login`) siguen igual; añadir comprobación de que la portada trae el menú y marca «Inicio»; mantener `not.toMatch(/https?:\/\/(?!www\.w3\.org)/)` (la portada no tiene enlaces externos). Actualizar `tests/unit/landing-copy.test.ts`: `visibleText()` **excluye la barra superior** (el menú lleva «Planes», palabra que la portada no debe usar en su contenido) y documentar el motivo en un comentario.

### Implementation for User Story 4

- [x] T019 [US4] Refactorizar `src/http/views/landing.ts` para usar `publicDocument({ current: "inicio", … })` conservando el `<main>` exacto de la portada (hero, beneficios y banda) y su título y descripción; borrar el `<header>`, el pie y el `<html>` duplicados. Los textos y enlaces de la portada no cambian. Depende de T004, T017 y T018.
- [x] T020 [US4] Añadir a `src/http/assets/styles.css` los estilos de la barra única: `.topbar nav` como contenedor flexible con `flex-wrap`, `.topbar__menu` (lista sin viñetas, enlaces con altura táctil ≥ 44 px), `.topbar__actions`, enlace actual con `[aria-current="page"]` (subrayado grueso y color primario, no solo color) y reacomodo en pantallas estrechas (marca arriba, menú en su fila, acceso en la siguiente; sin desbordar a 390 px). Ajustar las reglas existentes `.topbar nav > a:not(.btn)` a la nueva estructura. Depende de T010.

**Checkpoint**: T017/T018 en verde; las cuatro páginas comparten la barra.

---

## Phase 6: User Story 3 - Nosotros (Priority: P2)

**Goal**: `/nosotros` dice que Agenda Dental es un producto desarrollado por Innvend Works, con el enlace a su sitio y su contacto público.

**Independent Test**: abrir `/nosotros`: texto de Innvend, enlace `https://www.innvend.com` con `noopener noreferrer`, correo y teléfono, y nada más inventado.

### Tests for User Story 3 (escribirlos primero; deben fallar)

- [x] T021 [P] [US3] En `tests/unit/info-copy.test.ts` añadir «Nosotros»: términos prohibidos de «Todas las páginas» y de «Cómo funciona y Nosotros»; no aparecen `direccion`, `facebook`, `linkedin`, `instagram`, `twitter` ni `x.com`; sí aparecen «innvend works», «software, datos e ia para empresas» y «mas de 20 anos de experiencia».
- [x] T022 [US3] En `tests/contract/info-pages.test.ts` añadir el bloque «US3» para `GET /nosotros`: título, descripción y h1; «Agenda Dental es un producto desarrollado por Innvend Works.»; `<a href="https://www.innvend.com" target="_blank" rel="noopener noreferrer">www.innvend.com</a>`; `mailto:contacto@innvend.com` y `tel:+523312415547` con el texto visible `(52) 33 1241 5547`; la aclaración sobre el contacto del pie; el **único** dominio externo con `https?://` es `www.innvend.com`; el pie sigue con el correo de contacto configurado. Depende de T007.

### Implementation for User Story 3

- [x] T022A [US3] Endurecer la guardia de recursos externos en `tests/unit/design-guards.test.ts` (FR-020, «excepción acotada»): hoy ignora cualquier coincidencia con `innvend.com`; cambiar la regla para que `https://www.innvend.com` solo se admita en `src/http/views/about.ts` (y `soporte@innvend.com`/`agendadental.innvend.com` en los textos legales y la configuración donde ya aparecen), y que cualquier otra dirección con `innvend.com` (p. ej. `https://otro-innvend.com`) en vistas o estilos falle. Añadir un caso negativo que lo demuestre con un texto sintético. Depende de T021 y T022.
- [x] T023 [US3] Crear `src/http/views/about.ts` con `aboutPage({ year, contactEmail })` que arma el `<main>` (h1 «Nosotros», texto principal con el enlace, sección «Innvend Works», sección «Contacto de Innvend Works» con correo, teléfono y la aclaración; íconos `globe`, `mail`, `phone`) y llama a `publicDocument({ current: "nosotros", … })`. Textos literales del contrato. Depende de T004, T021 y T022.
- [x] T024 [US3] En `src/modules/home/info-routes.ts` añadir `GET /nosotros` con `aboutPage`. Depende de T015 y T023.
- [x] T025 [US3] Añadir a `src/http/assets/styles.css` los estilos de «Nosotros» (`.about`, lista de contacto con íconos, tarjeta de aclaración) con tokens de `:root`. Depende de T016.

**Checkpoint**: T021/T022 en verde; «Nosotros» funciona y es verificable sola.

---

## Phase 7: User Story 5 - Calidad transversal (Priority: P2)

**Goal**: públicas para todos los roles, accesibles, ligeras, sin recursos de terceros y sin cambiar el resto del sitio.

**Independent Test**: las pruebas de contrato y las auditorías existentes pasan con las rutas nuevas.

- [x] T026 [P] [US5] En `tests/contract/info-pages.test.ts` añadir el bloque «US5»: las tres rutas responden **200 sin redirección** para sin sesión, paciente, médico, recepción, soporte (con y sin segundo factor activo), sesión a medias y con un aviso legal pendiente (`legal.publish` de una versión nueva); `HEAD` responde 200 sin cuerpo y con las mismas cabeceras; sin `set-cookie`, `cache-control: no-store`, CSP igual a la de la portada; peso < 30 KB por página; un solo `<h1>`; sin `<form>`, `<input>`, `<script>` ni `style=`; íconos `aria-hidden`; variantes (`/planes/x`, `/Planes`, `/precios`) dan 404 y `POST /planes` no es 200; **límite de peticiones**: 121 peticiones seguidas a `/planes` desde la misma IP terminan en **429** (FR-023). Que las rutas no consultan la base de datos queda garantizado por construcción (el handler no recibe ni usa `services.db`) y se anota en el ADR (T030). Depende de T015 y T024.
- [x] T027 [P] [US5] Ampliar `tests/integration/route-audit.test.ts`: añadir `specs/008-paginas-informativas-publicas/contracts/http-routes.md` a `CONTRACT_FILES` y las tres rutas a la lista de rutas públicas; comprobar que `/` sigue siendo la única pública que redirige con sesión.
- [x] T028 [US5] Comprobar el recorrido de `tests/contract/design-shell.test.ts` y `tests/contract/design-a11y.test.ts` con las rutas nuevas (el cuerpo `landing` y el pie de la portada ya cumplen `expectDesigned`); correr ambos archivos y anotar el resultado en el ADR (T030); si algún recorrido falla por una razón válida de estas páginas, corregir la **página** (no la comprobación), y solo si la comprobación está mal planteada para páginas con cuerpo `landing`, ajustarla sin debilitarla y dejar el motivo en el commit. Confirmar que `tests/unit/design-guards.test.ts` pasa con el cambio de T022A.
- [x] T029 [US5] Ejecutar el grupo de pruebas afectado una por una (nunca dos corridas a la vez): `tests/unit/plans.test.ts`, `tests/unit/info-copy.test.ts`, `tests/unit/landing-copy.test.ts`, `tests/contract/info-pages.test.ts`, `tests/contract/landing.test.ts`, `tests/integration/route-audit.test.ts`, `tests/contract/design-shell.test.ts`, `tests/contract/design-a11y.test.ts`, `tests/unit/design-guards.test.ts`; corregir lo que falle. Depende de todo lo anterior.

**Checkpoint**: las cinco historias funcionan y las auditorías pasan.

---

## Phase 8: Polish & Cross-Cutting

- [x] T030 [P] Crear `docs/decisions/0009-paginas-informativas.md` (formato del 0008): decisión, marco compartido, exención de filtros, precios y redondeo al peso (349/699/1,399), promoción sin fecha y sujeta a cambio, aclaración del cobro, enlace externo acotado, riesgos abiertos (revisión de Jurídico y Contabilidad; verificación visual manual).
- [x] T031 [P] En `docs/legal/paquete-para-revision-legal.md` añadir (sección 7) «Planes y promoción»: precios $499/$999/$1,999 con IVA incluido, descuento de 30 % (muestra $349/$699/$1,399 redondeados al peso), «promoción de lanzamiento por tiempo limitado… sujetos a cambio», topes de WhatsApp «Próximamente», «durante el piloto no se realiza ningún cobro», con las preguntas para el abogado y Contabilidad (vigencia, redondeo, publicidad de precios y de promociones, aviso del cobro) y la lista de afirmaciones de «Cómo funciona» y «Nosotros». Marcar todo como provisional.
- [x] T032 Marcar las tareas hechas en este archivo, actualizar `docs/configuration.md` solo si hizo falta (no hay variables nuevas) y la spec si la implementación difiere (FR/SC).
- [ ] T033 Ejecutar `npm run lint`, `npm run typecheck` y la suite completa (`npx vitest run`, una sola corrida; ~65–70 min) por PowerShell; corregir fallos.
- [ ] T034 Commit en español imperativo y push; desplegar en Hostinger (sin variables, migraciones ni cron nuevos) y verificar en producción con [quickstart.md](quickstart.md): `curl -sI` de las tres rutas (200, `no-store`, sin `set-cookie`), barra idéntica, montos y enlaces. Dejar anotadas como pendientes manuales (casillas en el ADR 0009): revisión visual a 390 y 1440 px sin desplazamiento horizontal y con botones ≥ 44 px (SC-005); contraste ≥ 4.5:1 y foco visible (FR-021); recorrido con teclado (SC-008); lector de pantalla con el precio tachado como «Precio anterior» y los dos enlaces a `/` de la marca y de «Inicio»; tiempo de carga < 2 s (SC-007); y la validación de Jurídico y Contabilidad.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Fase 1)**: sin dependencias; T001 y T002 en paralelo.
- **Foundational (Fase 2)**: T003 depende de T002; T004 de T001; T005 de T004 (el módulo y su registro no requieren vistas aún). BLOQUEA las historias.
- **US1 (Fase 3)** → **US2 (Fase 4)** → **US4 (Fase 5)** → **US3 (Fase 6)** → **US5 (Fase 7)**: comparten `info-routes.ts`, `styles.css` e `info-pages.test.ts`, así que se hacen en este orden aunque cada página sea independiente en lo funcional.
- **Polish (Fase 8)**: después de las historias.

### Within Each User Story

- Las pruebas se escriben primero y deben fallar; luego vista → ruta → estilos.
- Tareas [P] solo si tocan archivos distintos (p. ej. T006 y T007; T011 y T012 no, porque T012 amplía el archivo de T006 y va después).

### Parallel Opportunities

- T001 ‖ T002.
- T006 ‖ T007 (archivos distintos).
- T011 ‖ (T012 y T013 después de T006 y T007).
- T017 ‖ T018.
- T026 ‖ T027.
- T030 ‖ T031.

## Parallel Example: User Story 1

```text
Task: "Crear tests/unit/info-copy.test.ts con visibleText() y términos prohibidos de «Cómo funciona»"
Task: "Crear tests/contract/info-pages.test.ts con el bloque US1 de /como-funciona"
```

## Implementation Strategy

### MVP First (User Story 1 + marco)

1. Fases 1 y 2 (marco compartido, exención, módulo de rutas).
2. Fase 3: «Cómo funciona» completa; validar sola.
3. **STOP y validar**: las pruebas T006/T007 en verde.

### Incremental Delivery

1. Marco + US1 → validar.
2. US2 (Planes) → validar montos, «Próximamente», promoción y cobro.
3. US4 (barra única en la portada y las páginas) → validar la barra idéntica.
4. US3 (Nosotros) → validar enlaces y texto.
5. US5 + Polish → auditorías, suite completa, despliegue y verificación en producción.

## Notes

- Los textos son literales de `contracts/page-content.md`; cualquier cambio de redacción se hace allí primero y luego en la vista y la prueba.
- Los precios, el descuento y los topes son **provisionales** hasta la revisión de Jurídico y Contabilidad (FR-015); no se anuncia esa leyenda al público.
- Commit tras cada tarea o grupo lógico; la suite completa corre una sola vez, al final (T033).
