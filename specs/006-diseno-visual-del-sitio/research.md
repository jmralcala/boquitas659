# Research: Diseño visual del sitio

Todas las decisiones de la persona responsable ya están en la spec (fuentes propias, sin funciones nuevas). Aquí se resuelve **cómo**. No quedan `NEEDS CLARIFICATION`.

## 1. Cómo servir la hoja de estilos y las fuentes

- **Decision**: una ruta propia, `GET /assets/styles.css` y `GET /assets/fonts/:file`, con **lista cerrada** de nombres (los archivos que existen en `dist/src/http/assets/`, leídos al arrancar) y tipo de contenido fijo (`text/css; charset=utf-8`, `font/woff2`). La hoja se lee una vez al arrancar y se sirve desde memoria; la URL lleva `?v=<hash corto del contenido>` para que un despliegue nuevo invalide la caché. Cabeceras: `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`. Límite de peticiones propio de 600 por minuto por IP (una página pide 3 recursos). Los archivos se leen **relativos al propio módulo** (`new URL("./assets/", import.meta.url)` en `src/http/asset-url.ts`), de modo que funcionan igual desde `src/` (vitest y desarrollo) y desde `dist/` (producción, tras `copy-assets`); el hash y `assetUrl()` viven en ese módulo, no en la ruta, para que la plantilla no dependa de un módulo de rutas.
- **Rationale**: la app no sirve archivos estáticos hoy; `@fastify/static` sería una dependencia nueva para servir 3 archivos (constitución VI). Una lista cerrada elimina el riesgo de recorrido de rutas (IV).
- **Alternatives**: `@fastify/static` (dependencia nueva y más superficie); servir desde `public_html` con LiteSpeed (la app Node vive fuera y se despliega por separado; complica el despliegue); incrustar la hoja en cada página con `<style>` (obliga a abrir la CSP a estilos en línea y no se cachea).

## 2. Fuentes: de dónde, qué formato y cuánto pesan

- **Decision**: **Inter** (400–700) y **Manrope** (600–800) como **fuentes variables WOFF2, subconjunto latino** (cubre el español: á é í ó ú ñ ü ¿ ¡). Se descargan una sola vez de los paquetes `@fontsource-variable/inter` y `@fontsource-variable/manrope` con `npm pack` en un directorio temporal (sin instalarlos ni tocar `package.json` ni el `lockfile`), se copian a `src/http/assets/fonts/` y se guardan sus licencias (SIL OFL 1.1) y versión en `LICENSES.md`. Declaración con `font-display: swap` y pila de respaldo del sistema (`system-ui, -apple-system, 'Segoe UI', sans-serif`). Peso esperado: ~50 KB + ~30 KB.
- **Rationale**: un archivo variable por familia cubre todos los pesos; el subconjunto latino evita cientos de KB; `swap` muestra texto legible de inmediato (caso límite de la spec); OFL permite incluirlas en el repositorio.
- **Alternatives**: Google Fonts (descartado por privacidad); fuentes del sistema solamente (más simple, pero cambia el aspecto según el equipo; la persona responsable eligió la opción propia); un archivo por peso (más peticiones y más KB).

## 3. Dónde se arma la estructura con sesión (barra lateral, navegación, «Salir»)

- **Decision**: `layout.ts` sigue exponiendo `page({ title, content })` **sin cambiar su firma** y emite marcas fijas (`<!--shell:open-->` … `<!--shell:close-->`) alrededor del contenido. Un gancho `onSend` en `src/http/shell.ts` (mismo patrón que el aviso de solo lectura y el botón «Salir» actuales) decide por la petición: **con sesión** reemplaza las marcas por barra lateral + contenedor principal; **sin sesión** las reemplaza por la tarjeta centrada. Los datos que necesita ya están en `request.auth` (rol, id) y en la URL (página activa); no hay consultas nuevas.
- **Rationale**: ninguna de las ~60 funciones de pantalla ni de los 14 archivos de rutas cambia de firma; una pantalla nueva que use `page()` hereda todo (FR-001); el token CSRF de «Salir» se deriva en el mismo lugar que hoy.
- **Alternatives**: pasar `rol` y `página activa` a cada vista (cambio masivo y riesgo de pantallas sin barra); renderizar con un motor de plantillas (dependencia nueva).

## 4. Qué muestra la tarjeta de usuario

- **Decision**: el **rol** («Médico», «Recepción», «Paciente», «Soporte») y el botón «Salir». No se muestra nombre ni correo.
- **Rationale**: la sesión no trae el correo ni el nombre; obtenerlos exigiría una consulta por página o ampliar la sesión (núcleo de autenticación, fuera de alcance), y mostrar menos datos personales en pantalla es coherente con la constitución I. La spec (FR-004) se ajusta a «rol de la persona».
- **Alternatives**: consulta del correo en cada render (costo y superficie); ampliar `SessionData` (cambio de autenticación sin necesidad).

## 5. Navegación por rol y página activa

- **Decision**: una tabla en `shell.ts` con **solo enlaces que existen hoy**:
  - Médico: Inicio (`/medicos/inicio`), Agenda (`/agenda`), Bloqueos (`/agenda/bloqueos`), Configuración (`/agenda/configuracion`), Mi micrositio (`/medicos/micrositio`), Recepción (`/medicos/recepcion`).
  - Recepción: Inicio (`/recepcion/panel`), Agenda (`/agenda`), Bloqueos (`/agenda/bloqueos`) (sin Configuración, como hoy).
  - Paciente: Inicio (`/pacientes/panel`), Mis citas (`/pacientes/citas`), Mis consultorios (`/pacientes/consultorios`).
  - Soporte: Resumen (`/soporte`), Médicos, Micrositios, Correos, Métricas, Historial (los de `NAV` actual).
  La página activa es la entrada cuyo prefijo más largo coincide con la ruta; se marca con `aria-current="page"`. Las pantallas de cuenta (`/cuenta/...`) muestran la barra con la navegación de su rol y ninguna entrada activa. Con **sesión a medias** (segundo factor o avisos legales pendientes) se muestran solo logo, tarjeta de usuario y «Salir», **sin navegación**, porque sus enlaces redirigirían. **Limitación conocida**: un médico aún no aprobado o suspendido ve la navegación completa (la sesión no trae su estado y consultarlo en cada página costaría una consulta); sus enlaces dan el 403 o la pantalla de estado de siempre, ya con el diseño común. Las pantallas del consultorio que abre una persona con sesión (por ejemplo la reserva de un paciente) usan la barra de su rol.
- **Rationale**: FR-005 prohíbe secciones nuevas; las existentes salen de las rutas reales del código.
- **Alternatives**: menú con «Pacientes/Doctores/Reportes» del documento de referencia (no existen).

## 6. Barra lateral en celular sin JavaScript

- **Decision**: con `flex-wrap`, la barra lateral (`flex: 1 1 248px`) pasa **arriba** del contenido en anchos estrechos; su navegación se vuelve **una fila con desplazamiento horizontal** y la tarjeta de usuario queda en una línea compacta. Sin menú de hamburguesa.
- **Rationale**: la app no usa JavaScript y la spec lo mantiene así; el patrón `flex-wrap` del documento de referencia lo resuelve sin consultas de medios complejas.
- **Alternatives**: menú desplegable con `<details>` (válido sin JS pero añade estados y pruebas; se puede valorar después).

## 7. Estilo «desde los elementos» y variantes con clases

- **Decision**: la hoja da estilo a **elementos desnudos** (`h1`, `h2`, `button`, `input`, `select`, `textarea`, `label`, `fieldset`, `legend`, `table`, `dl`, `ul.errors`, `small`, `a`) y añade clases solo para variantes: `.btn-secondary`, `.btn-danger`, `.badge--*`, `.alert--*`, `.card`, `.table-wrap`, `.empty`, `.chip`. El botón por defecto es el primario.
- **Rationale**: minimiza el marcado nuevo (FR-015) y evita pantallas sin estilo si alguien olvida una clase.
- **Alternatives**: clases en todos los elementos (más cambios, más omisiones).

## 8. Insignias de estado

- **Decision**: ayudante `badge(variant, text)` en `views/ui.ts` y **una función de mapeo por dominio** (cita, estado del médico, micrositio, correo, métrica), todas puras y con prueba unitaria. Las variantes son las cinco de la spec (`confirmed`, `in-progress`, `pending`, `cancelled`, `neutral`). El texto del estado siempre va escrito (no solo color).
- **Rationale**: un solo lugar fija el mapeo de FR-009; los mapeos puros son fáciles de probar.

## 9. Colores de las categorías de triaje

- **Decision**: en `triage-content.ts` el campo `color` (hex) se reemplaza por `tone` (1 a 5) y se actualiza `tests/unit/triage-content.test.ts:33`; texto, orden y categorías no cambian (es un cambio de presentación en un archivo cuyo contenido espera validación del dentista, y así se anota en el ADR 0007). Las 5 categorías (hoy `#c0392b`, `#e67e22`, `#d4ac0d`, `#7dcea0`, `#27ae60` puestos con `style=` en `urgent.ts`) pasan a **tokens propios en `:root`** (`--triage-1` … `--triage-5`) usados por clases `.triage--<id>`, conservando su orden y su texto. Se eligen tonos que cumplan el contraste con su texto; no se cambia el contenido médico ni el orden (validación del dentista pendiente).
- **Rationale**: elimina el último estilo en línea y el último color fuera de `:root`, y permite endurecer la CSP.

## 10. CSP

- **Decision**: configurar `helmet` con `style-src 'self'`, `font-src 'self'`, `img-src 'self' data:`, `default-src 'self'` y `script-src 'self'` (la app no usa scripts), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`; se elimina el comodín `https:` y `'unsafe-inline'` de estilos. Con `useDefaults: true` solo se sobrescriben las directivas listadas; el resto (incluida `upgrade-insecure-requests`) conserva su valor actual, así que no cambia el comportamiento en desarrollo ni en pruebas. Prueba: se comprueba la cabecera completa y ninguna directiva contiene `https:` ni `unsafe-inline`.
- **Rationale**: el valor por defecto de `helmet` admite estilos y fuentes de cualquier `https:` y estilos en línea; con `'self'` el navegador bloquea cualquier recurso externo (SC-005 pasa de «convención» a «garantía»).
- **Riesgo**: un `style=` olvidado dejaría de aplicarse. Mitigación: la guardia automática prohíbe `style=` en las vistas y la revisión visual lo detecta.

## 11. Íconos y logo

- **Decision**: SVG en línea de trazo (`stroke="currentColor"`, estilo Lucide, licencia ISC) escritos a mano en `views/icons.ts`: logo (diente), agenda, bloqueo, ajustes, micrositio, recepción, citas, consultorios, métricas, correo, historial, salir, y íconos de alerta. Decorativos con `aria-hidden="true"`.
- **Rationale**: sin librería ni fuente de íconos (FR-016), sin peticiones extra, tamaño mínimo.

## 12. Estrategia de pruebas

- **Contrato** (`design-shell.test.ts`): **enumera todas las rutas `GET` registradas** (opción `onRoute` de `createTestApp`, como `route-audit.test.ts`) y exige que cada una esté en el recorrido (con y sin sesión, por rol) o en una lista explícita de excepciones que no son pantallas; una ruta nueva sin clasificar hace fallar la prueba (SC-001). Comprueba hoja enlazada, `lang="es"`, viewport, salto al contenido, `<main id="contenido">`, barra solo con sesión completa, página activa y «Salir» solo con sesión. El único `h1` por pantalla se verifica en `design-a11y.test.ts`, cuando todas las pantallas ya están convertidas.
- **Recursos** (`assets-routes.test.ts`): tipos, caché, 404 para nombres fuera de la lista (incluidos `..`), límite de peticiones propio, CSP sin `https:` ni `unsafe-inline`.
- **Unitarias**: contraste de todas las parejas texto/fondo de los tokens (≥ 4.5:1; 3:1 en texto grande) y mapeos de insignias.
- **Guardias** (`design-guards.test.ts`): sin colores `#hex`/`rgb()` fuera de `:root` en la hoja, sin `style=` en el código de vistas, sin `https://` a dominios externos en la hoja y las vistas, peso total de recursos < 300 KB.
- **Manual**: capturas a 390 y 1440 px de un representante de cada tipo de pantalla, con teclado y con «reducir movimiento».
- **Suite existente**: se ejecuta completa en cada corte; solo se ajustan aserciones atadas a la estructura del marcado (hoy hay 0 pruebas que dependan de `<nav>`).

## 13. Despliegue

- **Decision**: `scripts/copy-assets.mjs` copia `src/http/assets` a `dist/src/http/assets`; el build del hosting (`npm run build`) ya lo ejecuta. Se despliega con el mismo procedimiento de hoy y se verifica en `agendadental.innvend.com`: hoja y fuentes responden 200 con caché larga, sin peticiones a terceros (revisión de la pestaña de red) y la CSP vigente.
- **Riesgo**: LiteSpeed podría tratar los `.woff2` por su cuenta. Mitigación: la ruta es de la app y se prueba tras desplegar.
