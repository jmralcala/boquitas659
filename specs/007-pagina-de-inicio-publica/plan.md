# Implementation Plan: Página de inicio pública

**Branch**: `007-pagina-de-inicio-publica` (sin rama propia: el trabajo sigue en `main`) | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-pagina-de-inicio-publica/spec.md`

## Summary

Añadir `GET /` como **portada pública** (hoy la raíz da «no encontrado») con barra superior, sección principal, cinco tarjetas, banda de llamada a la acción y pie, usando la hoja de estilos, las fuentes y los componentes de la feature 6. Sin datos, sin formularios, sin JavaScript, sin terceros.

Decisiones técnicas (detalle en [research.md](research.md)):

- **Vista propia que no usa la estructura de `page()`**: la portada tiene su cabecera y pie, no la barra lateral ni la tarjeta centrada. Se extrae de `layout.ts` el `<head>` común (hoja, fuentes, `noindex`, viewport, título) a una función compartida para no duplicarlo; como la portada no emite las marcas del shell, el gancho de la barra lateral no la toca.
- **Ruta nueva mínima** (`src/modules/home/home-routes.ts`): sesión completa → 303 al inicio del rol (la misma tabla `HOME_BY_ROLE` que usa `/login`); si no, la portada. Sin consultas a la base. El año sale del reloj del servicio; el correo de «Contacto» sale de `RIGHTS_CONTACT_EMAIL`.
- **Textos veraces** (opción A de la clarificación) en un solo lugar (`views/landing.ts`), verificados por una prueba contra una lista de términos prohibidos (reprogramar, WhatsApp, rentabilidad, precios…) y contra la lista de capacidades del piloto.
- **Estilos en la misma hoja** (`styles.css`): secciones de ancho completo, tarjetas en rejilla que se apila en celular, banda con el color primario; todo con tokens de `:root` (la guardia de la feature 6 sigue vigente).
- **`noindex` se conserva** (decisión: sin indexar durante el piloto); abrirla después es un cambio de una línea en la vista.
- **Sin caché de la página** (misma regla que el resto del HTML): la raíz depende de la cookie de sesión (redirige) y la página pesa poco; la hoja y las fuentes ya se cachean un año.
- **Un solo corte**: portada + pruebas + documentación + despliegue.

## Technical Context

**Language/Version**: TypeScript (Node.js LTS 22, ESM), CSS plano. Sin JavaScript de navegador.

**Primary Dependencies**: las existentes (Fastify 5, helmet, zod). **Ninguna dependencia nueva.**

**Storage**: N/A (sin base de datos, migraciones, variables de entorno ni cron nuevos).

**Testing**: vitest. Pruebas de contrato (portada: contenido, destinos, redirección por rol, sin formularios ni terceros), unitaria de veracidad del texto, y se ajustan la auditoría de rutas y el recorrido de pantallas de la feature 6 para admitir la nueva raíz.

**Target Platform**: hosting compartido Hostinger (Node 22); navegadores modernos de escritorio y celular.

**Project Type**: aplicación web renderizada en el servidor (monolito Fastify).

**Performance Goals**: HTML < 30 KB (SC-006) y portada en < 2 s; sin peticiones a terceros (SC-005).

**Constraints**: sin cookies ni analítica; sin `style=`; ningún color fuera de `:root`; no cambiar registro, login ni pantallas existentes; límite de peticiones por IP de las rutas públicas.

**Scale/Scope**: 1 ruta nueva, 1 vista, ~6 íconos nuevos, ~120 líneas de CSS, textos en español (≈ 25 frases).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Resultado | Cómo se cumple |
|---|---|---|
| I. Privacidad y datos de salud primero | **Pasa** | Sin datos personales, sin cookies, sin analítica, sin terceros. El pie enlaza el aviso de privacidad. «Contacto» usa el correo público de derechos, no el interno. |
| II. Aislamiento por médico | **Pasa (sin cambios)** | La ruta no consulta datos de ningún médico ni paciente. |
| III. Integridad de la agenda | **Pasa (sin cambios)** | No toca reservas, bloqueos ni enlaces. |
| IV. Seguridad y validación en runtime | **Pasa** | Ruta `GET` pública con límite de peticiones; no recibe entrada (ni query ni cuerpo); el único valor dinámico (correo de contacto) viene de la configuración validada y se escapa; CSP estricta de la feature 6 intacta. |
| V. Test-First | **Pasa** | Pruebas de contrato y de veracidad antes de la vista; la suite existente sigue verde. |
| VI. Simplicidad y operación realista | **Pasa** | Sin dependencias, procesos ni JavaScript; una ruta y una vista. |

Restricciones del producto: **el registro abierto de médicos sigue fuera de alcance**; la portada lleva al formulario ya existente, cuyas solicitudes soporte aprueba a mano (y la banda lo dice). Sin precios, cobro ni WhatsApp. La constitución prohíbe prometer funciones que no existen: se cumple con el texto veraz y su prueba.

**Dependencia aceptada (análisis A1, opción b)**: mientras los textos de médico sean provisionales, el registro en producción responde con su aviso de «revisión legal» (existente, sin cambios). La portada se publica igual; el registro se abre cuando un abogado revise y se publiquen los textos. Queda anotado en la spec, en el ADR 0008 y en la verificación de despliegue.

**Re-evaluación tras el diseño (Fase 1)**: sin violaciones. Una desviación menor justificada en «Complexity Tracking».

## Project Structure

### Documentation (this feature)

```text
specs/007-pagina-de-inicio-publica/
├── plan.md              # Este archivo
├── research.md          # Fase 0: decisiones y alternativas
├── data-model.md        # Fase 1: modelo de contenido (sin datos persistentes)
├── quickstart.md        # Fase 1: escenarios de validación
├── contracts/
│   ├── http-routes.md       # GET / y sus redirecciones
│   └── page-content.md      # Textos, destinos de enlaces, lista de capacidades y términos prohibidos
├── checklists/requirements.md
└── tasks.md             # Fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── http/
│   ├── views/
│   │   ├── layout.ts          # CAMBIA: se extrae `documentHead()` (hoja, fuentes, noindex, viewport, título, descripción opcional); `page()` lo usa
│   │   ├── icons.ts           # CAMBIA: añade timer, bell, shield, arrow-right y log-in
│   │   └── landing.ts         # NUEVO: `landingPage({ year, contactEmail })`
│   └── assets/styles.css      # CAMBIA: estilos de la portada (cabecera, sección principal, rejilla de tarjetas, banda, pie)
├── modules/home/
│   └── home-routes.ts         # NUEVO: GET / (redirige con sesión completa, si no muestra la portada)
└── compose.ts                 # CAMBIA: registra `registerHomeRoutes`
tests/
├── contract/landing.test.ts           # NUEVO: contenido, destinos, sin formularios/terceros, redirección por rol, sesión a medias
├── unit/landing-copy.test.ts          # NUEVO: términos prohibidos y lista de capacidades
├── integration/route-audit.test.ts    # CAMBIA: incluye el contrato 007 y `/` como ruta pública
└── contract/design-shell.test.ts      # CAMBIA: el pie legal de la portada es su propio pie (enlace al aviso de privacidad)
docs/decisions/0008-pagina-de-inicio.md   # NUEVO
```

**Structure Decision**: monolito único existente; un módulo pequeño `home` para la ruta, la vista junto a las demás vistas.

## Entrega

Un solo corte (`/speckit-implement`): refactor del `<head>`, íconos y estilos → pruebas de contenido y de veracidad → vista y ruta → ajuste de la auditoría de rutas y del recorrido de pantallas → documentación → despliegue y verificación en producción. Commit al terminar con la suite verde.

## Complexity Tracking

| Desviación | Por qué hace falta | Alternativa más simple descartada porque |
|---|---|---|
| La portada no usa `page()` ni el shell de la feature 6 (tiene su cabecera y pie) | Es una página de marketing de ancho completo con navegación propia; la barra lateral y la tarjeta centrada no sirven | Forzar `page()` con la barra lateral para visitantes con sesión parcial rompería el diseño de la referencia, y la tarjeta centrada la encogería |
