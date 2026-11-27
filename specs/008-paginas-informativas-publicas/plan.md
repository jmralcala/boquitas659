# Implementation Plan: Páginas informativas públicas (Cómo funciona, Planes y Nosotros)

**Branch**: `008-paginas-informativas-publicas` (sin rama propia: el trabajo sigue en `main`) | **Date**: 2026-11-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-paginas-informativas-publicas/spec.md`

## Summary

Añadir tres páginas públicas (`/como-funciona`, `/planes`, `/nosotros`) y convertir la barra superior de la portada (feature 7) en la **barra de menú única** compartida por las cuatro páginas públicas. Contenido fijo en español, sin datos, sin formularios, sin JavaScript y sin terceros, con la hoja de estilos y las fuentes de la feature 6.

Decisiones técnicas (detalle en [research.md](research.md)):

- **Marco público compartido** (`src/http/views/public-site.ts`): una función que arma el documento completo de las páginas públicas (cabecera con la barra única, `<main>`, pie). La portada (`landing.ts`) se refactoriza para usarla y las tres páginas nuevas la reutilizan; así la barra es idéntica por construcción. No usa `page()` ni emite marcas del shell (misma decisión de la feature 7).
- **Menú sin JavaScript**: una sola `<nav aria-label="Principal">` con dos grupos (menú y acceso); en pantallas estrechas los grupos se acomodan en filas con `flex-wrap`. La página actual lleva `aria-current="page"`.
- **Planes desde una fuente única** (`src/http/views/plans.ts`): los tres precios originales en pesos y el porcentaje de descuento; el precio con descuento se **calcula** con enteros (70 % redondeado al peso más cercano, sin centavos) y se formatea en MXN. Una prueba compara contra los montos acordados.
- **Rutas mínimas** (`src/modules/home/info-routes.ts`): tres `GET` públicos sin entrada ni base de datos, con el mismo límite de peticiones que la portada. A diferencia de `/`, **no redirigen con sesión**; por eso se **eximen de los dos filtros globales** (avisos legales pendientes y segundo factor de soporte) mediante una lista compartida `PUBLIC_INFO_PATHS`, igual que ya se eximen `/legal` y `/assets/`.
- **Texto veraz con prueba**: los textos viven en las vistas; una prueba unitaria rechaza términos prohibidos en «Cómo funciona» y «Nosotros» y limita WhatsApp a «Planes» siempre con «Próximamente». La prueba de la portada deja de contar el menú (que lleva «Planes»).
- **Enlace externo acotado**: `www.innvend.com`, su correo y su teléfono son navegación; la guardia de recursos externos ya admite `innvend.com`; la prueba de la portada que prohíbe `https?://` se limita a las páginas sin esa excepción.
- **Sin indexar** y **sin caché**, como la portada.
- **Un solo corte**: refactor + páginas + pruebas + documentación + despliegue.

## Technical Context

**Language/Version**: TypeScript (Node.js LTS 22, ESM), CSS plano. Sin JavaScript de navegador.

**Primary Dependencies**: las existentes (Fastify 5, helmet, zod). **Ninguna dependencia nueva.**

**Storage**: N/A (sin base de datos, migraciones, variables de entorno ni cron nuevos).

**Testing**: vitest. Contrato por página (contenido, destinos, barra idéntica, sin formularios ni terceros salvo la excepción), unitarias de cálculo de precios y de veracidad del texto, y ajustes de la auditoría de rutas, el recorrido de pantallas de la feature 6 y las pruebas de la portada.

**Target Platform**: hosting compartido Hostinger (Node 22); navegadores modernos de escritorio y celular.

**Project Type**: aplicación web renderizada en el servidor (monolito Fastify).

**Performance Goals**: cada HTML < 30 KB y < 2 s (SC-007); sin peticiones a terceros (SC-006).

**Constraints**: sin cookies ni analítica; sin `style=`; ningún color fuera de `:root`; no cambiar registro, login, cobro ni pantallas con sesión; límite de peticiones por IP; CSP de la feature 6 sin ampliar.

**Scale/Scope**: 3 rutas nuevas, 1 marco compartido y 4 vistas, 2 íconos nuevos (`check` y `phone`), ~150 líneas de CSS, textos en español (≈ 60 frases).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Resultado | Cómo se cumple |
|---|---|---|
| I. Privacidad y datos de salud primero | **Pasa** | Sin datos personales, sin cookies, sin analítica, sin terceros; el enlace a Innvend se abre con `noopener noreferrer` para no entregar el origen. |
| II. Aislamiento por médico | **Pasa (sin cambios)** | Las rutas no consultan datos de ningún médico ni paciente. |
| III. Integridad de la agenda | **Pasa (sin cambios)** | No toca reservas, bloqueos ni enlaces. |
| IV. Seguridad y validación en runtime | **Pasa** | `GET` públicos con límite de peticiones; no leen query ni cuerpo; los únicos valores dinámicos (año y correo de contacto) vienen del reloj y de la configuración validada y se escapan; CSP estricta intacta. Eximir las rutas de los filtros globales es seguro porque no muestran ni modifican datos. |
| V. Test-First | **Pasa** | Pruebas de cálculo, contenido y veracidad antes de las vistas. |
| VI. Simplicidad y operación realista | **Pasa** | Sin dependencias ni JavaScript; contenido fijo en código. |

Restricciones del producto: **sin WhatsApp ni cobro automático en el piloto** (alcance del piloto en la constitución): «Planes» muestra WhatsApp solo como «Próximamente» y aclara que no hay cobro todavía; no se promete reprogramación (fuera de alcance). La constitución no regula la publicidad ni los precios; aquí rige la **regla de veracidad de la feature 7 (FR-009)** y no se prometen condiciones contractuales: los precios y el descuento son decisión de la persona responsable (27/11/2026), se publican **sin fecha de vigencia y sujetos a cambio**, y quedan **provisionales hasta la revisión de Jurídico y Contabilidad** (se documenta en el paquete legal). Se amplía lo que la feature 7 dejó fuera (precios y planes) únicamente en «Planes».

**Re-evaluación tras el diseño (Fase 1)**: sin violaciones. Dos desviaciones menores en «Complexity Tracking».

## Project Structure

### Documentation (this feature)

```text
specs/008-paginas-informativas-publicas/
├── plan.md              # Este archivo
├── research.md          # Fase 0: decisiones y alternativas
├── data-model.md        # Fase 1: modelo de contenido (Plan, menú; sin datos persistentes)
├── quickstart.md        # Fase 1: escenarios de validación
├── contracts/
│   ├── http-routes.md       # Las tres rutas, filtros globales y cabeceras
│   └── page-content.md      # Textos, destinos, montos, lista de capacidades y términos prohibidos
├── checklists/requirements.md
└── tasks.md             # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── http/
│   ├── public-paths.ts        # NUEVO: PUBLIC_INFO_PATHS (rutas informativas eximidas de los filtros globales)
│   ├── views/
│   │   ├── public-site.ts     # NUEVO: marco compartido (barra única, main, pie) y MENU
│   │   ├── landing.ts         # CAMBIA: usa el marco; el contenido de la portada no cambia
│   │   ├── how-it-works.ts    # NUEVO: howItWorksPage()
│   │   ├── plans.ts           # NUEVO: PLANS, DISCOUNT_PERCENT, priceWithDiscount(), formatMxn(), plansPage()
│   │   ├── about.ts           # NUEVO: aboutPage()
│   │   └── icons.ts           # CAMBIA: añade check y phone
│   └── assets/styles.css      # CAMBIA: menú, encabezado de página, pasos, tarjetas de plan, precio tachado, «Próximamente»
├── modules/
│   ├── home/info-routes.ts    # NUEVO: GET /como-funciona, /planes, /nosotros
│   └── legal/legal-gate.ts    # CAMBIA: exime PUBLIC_INFO_PATHS
├── http/support-mfa.ts        # CAMBIA: exime PUBLIC_INFO_PATHS
└── compose.ts                 # CAMBIA: registra registerInfoRoutes
tests/
├── contract/info-pages.test.ts        # NUEVO: contenido, destinos, barra idéntica, sin formularios/terceros, públicas para los 4 roles
├── unit/plans.test.ts                 # NUEVO: cálculo del 70 % redondeado al peso, formato MXN y montos acordados
├── unit/info-copy.test.ts             # NUEVO: términos prohibidos por página y «Próximamente» en WhatsApp
├── contract/landing.test.ts           # CAMBIA: la barra única; la ausencia de https:// sigue para la portada
├── unit/landing-copy.test.ts          # CAMBIA: no cuenta el menú (lleva «Planes»)
├── integration/route-audit.test.ts    # CAMBIA: contrato 008 y las 3 rutas como públicas
└── contract/design-shell.test.ts, design-a11y.test.ts   # CAMBIAN si el recorrido exige ajustes (cuerpo de portada compartido)
docs/decisions/0009-paginas-informativas.md     # NUEVO
docs/legal/paquete-para-revision-legal.md       # CAMBIA: precios, descuento y texto de «Planes» como provisionales
```

**Structure Decision**: monolito único existente; el módulo `home` ya existe (feature 7) y recibe las tres rutas; las vistas junto a las demás.

## Entrega

Un solo corte (`/speckit-implement`): pruebas de cálculo, contenido y veracidad → marco compartido, íconos y estilos → vistas y rutas → exención de filtros → ajuste de portada y de auditorías → documentación y paquete legal → despliegue y verificación en producción. Commit al terminar con la suite verde.

## Complexity Tracking

| Desviación | Por qué hace falta | Alternativa más simple descartada porque |
|---|---|---|
| Las tres rutas se eximen de los filtros globales de avisos legales y segundo factor | La spec pide que se muestren a cualquier persona, con o sin sesión (SC-009); sin la exención, quien tiene avisos pendientes rebotaría a `/legal/aceptar` | Dejarlas sujetas a los filtros contradice la spec y daría una experiencia distinta a la de `/legal` y `/derechos`, que ya están eximidas |
| Se duplica de forma controlada la lista de rutas eximidas en dos filtros | Cada filtro ya tiene su propia función `isExempt` | Unificar los dos filtros es un refactor ajeno a esta feature; se comparte solo la nueva lista `PUBLIC_INFO_PATHS` |
