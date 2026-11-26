# 0007 — Diseño visual del sitio (feature 6)

Fecha: 26/11/2026. Estado: vigente. Spec: `specs/006-diseno-visual-del-sitio/`.

## Decisión

Todas las pantallas comparten un sistema visual verde azulado, menta y cielo, aplicado desde **un solo lugar** y sin cambiar la funcionalidad.

- **Una hoja de estilos** (`src/http/assets/styles.css`). Los colores, radios, espaciado y tipografía viven en `:root`; ningún color suelto fuera de él. Los elementos HTML sin clase (botones, campos, tablas) ya tienen estilo; las clases solo añaden variantes (`btn-secondary`, `btn-danger`, `badge--*`, `alert--*`, `card`, `table-wrap`, `chip`).
- **Fuentes propias**: Inter (cuerpo) y Manrope (títulos), WOFF2 variable de subconjunto latino (73 KB), licencia SIL OFL 1.1 (`src/http/assets/fonts/LICENSES.md`). No se usa Google Fonts: cada visita enviaría a un tercero la IP y el navegador de un paciente (LFPDPPP; mismo criterio con el que se retiró el mapa de Google).
- **Recursos desde el propio sitio**: `GET /assets/styles.css` y las dos fuentes, rutas literales (lista cerrada en `asset-url.ts`), caché de un año `immutable`, `?v=<hash>` en la hoja, límite propio de 600 peticiones por minuto por IP. Cualquier otro nombre da el 404 uniforme. Sin dependencias nuevas (`@fastify/static` descartado).
- **CSP solo con recursos propios** (`style-src 'self'`, `font-src 'self'`, sin `https:` ni `unsafe-inline`). Única excepción heredada: el CAPTCHA de Turnstile del formulario de urgencia (feature 4), que amplía `script-src` y `frame-src` solo en esa pantalla.
- **Estructura común en un solo gancho** (`src/http/shell.ts`): `page()` deja marcas; con sesión se arma la barra lateral con la navegación del rol, la página activa (`aria-current`) y «Salir»; sin sesión, la tarjeta centrada. Las ~60 pantallas no cambiaron de firma.
- **Sesión a medias** (segundo factor pendiente, soporte sin segundo factor, avisos por aceptar): solo logo, rol y «Salir», sin navegación (sus enlaces redirigirían).
- **Sin JavaScript**: en celular la barra pasa arriba y la navegación es una fila desplazable.
- **Insignias de estado** con texto y color (nunca solo color), mapeo único en `views/ui.ts`.
- **Triaje**: el campo `color` de `triage-content.ts` pasó a `tone` (1 a 5) que elige una clase del sistema. Es un cambio de **presentación**; el texto, el orden y las categorías no cambiaron y la validación pendiente del dentista no se ve afectada.

## Riesgos abiertos

- La CSP estricta deja sin efecto cualquier `style=` o recurso externo que se agregue por descuido. La guardia `tests/unit/design-guards.test.ts` los prohíbe y la revisión visual (`docs/design-review.md`) los detecta.
- Un médico aún no aprobado o suspendido ve la navegación completa del médico (la sesión no trae su estado); sus enlaces dan el 403 o la pantalla de estado de siempre, ya con el diseño.
- LiteSpeed podría tratar los `.woff2` por su cuenta; se comprueba tras cada despliegue.
- La verificación visual a 390 y 1440 px es manual (no hay navegador automatizado en el proyecto).

## Cómo cambiar el diseño

Cambiar un color, radio o espaciado: editar el token en `:root` de `styles.css` (el contraste se vuelve a comprobar en `tests/unit/design-tokens.test.ts`). Una pantalla nueva que use `page()` hereda hoja, fuentes, estructura y pie legal sin trabajo adicional; si usa un color nuevo, debe ser un token.
