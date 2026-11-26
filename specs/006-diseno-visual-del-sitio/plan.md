# Implementation Plan: Diseño visual del sitio

**Branch**: `006-diseno-visual-del-sitio` (sin rama propia: el trabajo sigue en `main`) | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-diseno-visual-del-sitio/spec.md`

## Summary

Dar a **todas** las pantallas un sistema visual común (verde azulado, menta y cielo) sin tocar la lógica. El enfoque, en una frase: **una hoja de estilos propia que da estilo a los elementos HTML «desnudos» (botones, campos, tablas, listas), más unas pocas clases para las variantes (peligro, insignias, avisos, tarjetas), y una estructura de página común (barra lateral con navegación por rol, tarjeta de usuario con «Salir») que se arma en un solo lugar**. Así casi ninguna vista cambia su lógica y el marcado crece poco.

Decisiones técnicas (detalle en [research.md](research.md)):

- La app **ya genera todo el HTML desde una plantilla común** (`page()` en `src/http/views/layout.ts`, usada por 14 archivos) y no sirve archivos estáticos. Se añade una **ruta propia de recursos** (`/assets/...`) con lista cerrada de archivos, sin dependencias nuevas.
- **Fuentes propias** (decisión de la persona responsable): Inter y Manrope en WOFF2 variable, subconjunto latino, de licencia libre, guardadas en el repositorio. Cero peticiones a terceros.
- **Estructura con sesión**: la plantilla emite marcas fijas y **un único gancho de respuesta** (`src/http/shell.ts`, del mismo estilo que el de solo lectura y el de «Salir» que ya existen) añade barra lateral, navegación por rol con la página activa y tarjeta de usuario con «Salir». Las ~60 funciones de pantalla **no cambian de firma**.
- **Sin JavaScript**: la barra lateral pasa a barra superior con navegación en fila desplazable en celular.
- **Política de seguridad de contenido (CSP) más estricta**, no más laxa: hoy el valor por defecto de `helmet` admite hojas de estilo y fuentes de cualquier origen `https:` y estilos en línea; se fija a `'self'` para que el navegador **impida** cualquier recurso de terceros (refuerza SC-005).
- Entrega en **cuatro cortes** con commit cada uno: cimientos y acceso, paciente, médico y recepción, soporte; y una pasada transversal de accesibilidad.

## Technical Context

**Language/Version**: TypeScript (Node.js LTS 22, ESM), CSS plano moderno (variables, flexbox, grid). Sin preprocesador, sin JavaScript de navegador.

**Primary Dependencies**: las existentes (Fastify 5 con `@fastify/helmet`, zod 4). **Ninguna dependencia nueva**: no se usa `@fastify/static` (una ruta de ~40 líneas basta), ni librerías de íconos, ni de CSS. Las fuentes se obtienen una sola vez de los paquetes `@fontsource-variable/inter` y `@fontsource-variable/manrope` (o de la fuente oficial) **sin instalarlas en el proyecto** y se copian al repositorio con su licencia.

**Storage**: N/A (sin cambios en base de datos ni migraciones). Archivos estáticos en `src/http/assets/`, copiados a `dist/` por `scripts/copy-assets.mjs`.

**Testing**: vitest. Nuevas pruebas de contrato (recorrido de pantallas, estructura, recursos), unitarias (contraste de los tokens, mapeos de estado) y de «guardia» (sin colores sueltos, sin `style=`, sin orígenes externos). La verificación visual a 390 px y 1440 px es **manual y documentada** (no hay navegador automatizado en el proyecto).

**Target Platform**: hosting compartido Hostinger (Node 22 con LiteSpeed/Passenger); navegadores modernos de escritorio y celular.

**Project Type**: aplicación web renderizada en el servidor (monolito Fastify).

**Performance Goals**: hoja + fuentes < 300 KB en total (SC-006); micrositio y calendario < 2 s (SC-008 de la feature 3); hoja y fuentes con caché de larga duración.

**Constraints**: cero recursos de terceros; sin estilos en línea; ningún color fuera de `:root`; sin cambios funcionales (rutas, métodos, nombres de campos, textos legales y de triaje); cambios de marcado mínimos; el límite de peticiones por IP sigue vigente (con tope propio, más alto, para recursos).

**Scale/Scope**: ~60 funciones de pantalla en 14 archivos (`calendar.ts` 466 líneas, `site.ts` 479, `urgent.ts` 129, `support-views.ts` 322, `forms.ts` 73, y HTML en línea en rutas de `auth`, `doctors`, `legal`, `patients`, `reception`), 23 tablas/listas de definición/formularios agrupados, 5 categorías de triaje con color, 4 roles con sesión.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Resultado | Cómo se cumple |
|---|---|---|
| I. Privacidad y datos de salud primero | **Pasa** | Cero peticiones a terceros (fuentes y íconos propios) y la CSP lo impone en el navegador. La tarjeta de usuario muestra solo el rol (no se añade una consulta con el correo en cada página). Nada de datos personales en clases, atributos ni registros. Los textos legales y de triaje no se alteran; la instrucción de acudir a un hospital gana prominencia. |
| II. Aislamiento por médico | **Pasa (sin cambios)** | No se toca ninguna consulta ni ruta de datos. |
| III. Integridad de la agenda | **Pasa (sin cambios)** | No se tocan reservas, bloqueos ni enlaces; los botones cambian de aspecto, no de método ni de campos. |
| IV. Seguridad y validación en runtime | **Pasa con vigilancia** | La ruta de recursos valida el nombre contra una lista cerrada (sin rutas construidas con entrada del usuario), fija el tipo de contenido y usa límite de peticiones propio. La CSP se **endurece** a `'self'`. Los formularios conservan CSRF y nombres de campos. Se prohíben los estilos en línea (los que quedan se eliminan). |
| V. Test-First | **Pasa** | Pruebas de contrato y guardias nuevas antes o junto con cada corte; la suite existente debe seguir verde (solo se ajustan aserciones sobre marcado). |
| VI. Simplicidad y operación realista | **Pasa** | Sin dependencias nuevas, sin procesos, sin JavaScript, sin preprocesador; una hoja, una ruta, un gancho. Las fuentes pesan ~80 KB. |

Restricciones del producto: sin cambios en el alcance del piloto; el micrositio mantiene `noindex`.

**Re-evaluación tras el diseño (Fase 1)**: sin violaciones. Dos puntos con justificación en «Complexity Tracking».

## Project Structure

### Documentation (this feature)

```text
specs/006-diseno-visual-del-sitio/
├── plan.md              # Este archivo
├── research.md          # Fase 0: decisiones y alternativas
├── data-model.md        # Fase 1: modelo de diseño (tokens, componentes, mapeos); sin datos persistentes
├── quickstart.md        # Fase 1: escenarios de validación
├── contracts/
│   ├── ui-shell.md          # Estructura de página, marcas, navegación por rol, página activa
│   └── assets-and-components.md  # Rutas de recursos, cabeceras, clases y ayudantes de componentes
├── checklists/requirements.md
└── tasks.md             # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/http/
├── assets/                       # NUEVO: recursos estáticos del diseño
│   ├── styles.css                #   tokens, base, layout y componentes (una sola hoja)
│   └── fonts/
│       ├── inter-var-latin.woff2
│       ├── manrope-var-latin.woff2
│       └── LICENSES.md           #   licencia OFL de ambas y versión de origen
├── asset-url.ts                  # NUEVO: lee los recursos relativo al propio módulo (sirve desde src/ y dist/), hash corto y assetUrl(); lo usan la ruta y la plantilla
├── assets-routes.ts              # NUEVO: GET /assets/styles.css y /assets/fonts/:file (lista cerrada, caché larga, límite propio)
├── shell.ts                      # NUEVO: gancho de respuesta + definición de navegación por rol + página activa + «Salir»
├── app.ts                        # CAMBIA: CSP estricta, gancho del shell (sustituye al de «Salir»), aviso de solo lectura como alerta, páginas de error con el diseño
└── views/
    ├── layout.ts                 # CAMBIA: <head> con hoja, tema y salto al contenido; marcas del shell; pie legal
    ├── ui.ts                     # NUEVO: ayudantes badge(), alert(), card(), tableWrap(), emptyState(), definitionList()
    ├── icons.ts                  # NUEVO: íconos SVG en línea (trazo) y logo
    ├── forms.ts                  # CAMBIA: etiquetas, errores y botones con las clases del sistema
    ├── calendar.ts · site.ts · urgent.ts   # CAMBIAN: clases, insignias, tablas envueltas, sin estilos en línea
    └── (resto de vistas con HTML en línea en las rutas de auth, doctors, legal, patients, reception)
src/modules/support/support-views.ts  # CAMBIA: usa el shell (se retira su <nav> propio), insignias y tablas envueltas
src/modules/urgent/triage-content.ts  # CAMBIA: el campo `color` (hex) pasa a `tone` (1 a 5); texto, orden y categorías intactos (+ tests/unit/triage-content.test.ts)
scripts/copy-assets.mjs               # CAMBIA: copia src/http/assets a dist
tests/
├── contract/design-shell.test.ts     # NUEVO: recorrido de pantallas, estructura, navegación, «Salir»
├── contract/assets-routes.test.ts    # NUEVO: recursos, cabeceras, lista cerrada, CSP, límite
├── unit/design-tokens.test.ts        # NUEVO: contraste de las combinaciones del sistema; mapeos de insignias
└── unit/design-guards.test.ts        # NUEVO: sin colores fuera de :root, sin style=, sin orígenes externos, peso < 300 KB
```

**Structure Decision**: monolito único existente. El diseño vive en `src/http/assets/` (estático) y en tres piezas pequeñas de TypeScript (`assets-routes.ts`, `shell.ts`, `views/ui.ts`+`icons.ts`). No se crea ningún proyecto ni paquete nuevo.

## Entregas (cada una con su commit y la suite verde)

1. **Cimientos y acceso (US1 parte 1, US4)**: fuentes y licencias, `styles.css` con tokens, base y componentes, ruta de recursos, CSP estricta, `layout.ts` con marcas y salto al contenido, gancho del shell, páginas de error con el diseño, `forms.ts`, `ui.ts`/`icons.ts`. Pantallas de acceso, registro, estado, avisos legales y derechos. Pruebas de recursos, guardias y contraste.
2. **Visitantes y paciente (US1 parte 2)**: micrositio, entrada, primera cita, enlace de cita, reserva (horarios), mis citas, mis consultorios, urgencias (con la instrucción de hospital como elemento principal y las categorías de triaje como clases del sistema), insignias de estado de cita.
3. **Médico y recepción (US2)**: agenda del día y la semana, nueva cita, detalle, bloqueos, configuración, mi micrositio, pacientes, recepción, cuenta; navegación por rol; aviso de solo lectura como alerta.
4. **Soporte (US3)**: panel completo (se retira el `<nav>` propio), tablas envueltas, insignias de médico, micrositio y correo, métricas con «cumple / no cumple».
5. **Pasada transversal (US4)**: revisión con teclado y a 390/1440 px, ajustes de contraste y foco, revisión visual documentada, documentación (`docs/decisions/0007-diseno-visual.md`, `docs/configuration.md`), despliegue y verificación en `agendadental.innvend.com`.

## Complexity Tracking

| Desviación | Por qué hace falta | Alternativa más simple descartada porque |
|---|---|---|
| Gancho de respuesta que arma la estructura (`shell.ts`) en lugar de pasar el contexto a cada pantalla | Cambiar la firma de ~60 funciones de vista y de 14 archivos de rutas para pasarles rol y página actual multiplicaría el riesgo y el diff; el patrón ya existe (aviso de solo lectura y botón «Salir» se inyectan igual) | Pasar un objeto de contexto a cada `page()`: invasivo y propenso a omisiones (una pantalla sin la barra) |
| Endurecer la CSP (de `https:` + estilos en línea a solo `'self'`) | Es la única forma de que el **navegador** impida un recurso de terceros, que es el requisito de privacidad (FR-016, SC-005) | Dejar la CSP por defecto: depende de que nadie añada un `<link>` externo por descuido; ya hay un estilo en línea (`urgent.ts`) que habría que conservar |
