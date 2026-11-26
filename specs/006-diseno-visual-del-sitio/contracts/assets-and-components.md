# Contrato: recursos estáticos y componentes

## Rutas de recursos (`http/assets-routes.ts`)

| Ruta | Respuesta | Cabeceras |
|---|---|---|
| `GET /assets/styles.css` | La hoja de estilos (leída al arrancar) | `Content-Type: text/css; charset=utf-8`, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` |
| `GET /assets/fonts/inter-var-latin.woff2` y `GET /assets/fonts/manrope-var-latin.woff2` | Las fuentes | `Content-Type: font/woff2`, mismas cabeceras de caché y `nosniff` |
| Cualquier otro nombre bajo `/assets/` (incluidos `..`, subdirectorios, mayúsculas distintas) | **404** idéntico al de una ruta inexistente | — |

Reglas:

- Solo `GET` y `HEAD`. Cada archivo es una **ruta literal** (la lista cerrada de `asset-url.ts`): cualquier otro nombre cae en el 404 uniforme de la aplicación y nunca se construye una ruta de disco con el valor recibido. Un camino con `..` que se normaliza a uno de los tres archivos legítimos (por ejemplo `/assets/fonts/../styles.css`) sirve ese archivo, igual que lo haría cualquier servidor.
- Las rutas de `/assets/` están exentas de los filtros de avisos legales pendientes y de activación del segundo factor de soporte: sin ellas la propia pantalla de aceptación o de alta se vería sin estilo.
- Límite de peticiones propio: **600 por minuto por IP** (el global de 300 no aplica a esta ruta). Superarlo responde 429 como el resto.
- No lleva cookies, no requiere sesión y no se registra el contenido.
- Los archivos se leen **relativos al propio módulo** (`src/http/asset-url.ts`), así que funcionan igual desde `src/` (pruebas y desarrollo) y desde `dist/` (producción); `assetUrl(name)` vive en ese módulo y lo usan la ruta y la plantilla.
- La URL de la hoja incluye `?v=<hash corto del contenido>`; el hash cambia con el contenido, por lo que un despliegue nuevo invalida la caché.
- Las respuestas de `/assets/` **no** reciben `Cache-Control: no-store` (el gancho de «sin caché» solo aplica a HTML).

## Cabeceras de seguridad (`helmet`)

`Content-Security-Policy` (valor completo, sin `https:` ni `unsafe-inline`):

```
default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Se configura con `useDefaults: true`: solo se sobrescriben las directivas de arriba y el resto conserva su valor actual (incluida `upgrade-insecure-requests`). Las demás cabeceras de `helmet` se mantienen. El micrositio ya no necesita ampliar la CSP (se retiró el mapa incrustado).

## Ayudantes de componentes (`views/ui.ts`, `views/icons.ts`)

Funciones puras que devuelven `SafeHtml` (el texto del usuario se escapa como hoy):

| Ayudante | Firma | Emite |
|---|---|---|
| `badge` | `badge(variant, text)` | `<span class="badge badge--{variant}"><span class="badge__dot" aria-hidden="true"></span>{text}</span>` |
| `alert` | `alert(variant, content, options?)` | `<div class="alert alert--{variant}" role="status|alert">` con ícono `aria-hidden` y el contenido |
| `card` | `card(title, content, actions?)` | `<section class="card"><header><h2>…</h2>…</header>…</section>` |
| `tableWrap` | `tableWrap(table)` | `<div class="table-wrap">{table}</div>` |
| `emptyState` | `emptyState({ title, text, action? })` | `<div class="empty">…</div>` |
| `definitionList` | `definitionList(rows)` | `<dl>` con filas etiqueta-valor |
| `icon` | `icon(name)` | `<svg aria-hidden="true" …>` de trazo (`currentColor`) |

Mapeos de estado (puros, con prueba unitaria): `appointmentBadge`, `doctorApprovalBadge`, `doctorAccountBadge`, `siteBadge`, `mailBadge`, `metricBadge` según la tabla de [data-model.md](../data-model.md) §3. Devuelven `{ variant, text }`; `badgeOf(spec)` los convierte en la insignia.

**Excepción de CSP del formulario de urgencia**: `src/modules/urgent/csp.ts` amplía `script-src` y `frame-src` con `https://challenges.cloudflare.com` solo en esa pantalla (CAPTCHA Turnstile de la feature 4). No cambia.

## Clases públicas de la hoja (lo que el marcado puede usar)

`card`, `card-page`, `has-shell`, `app`, `sidebar`, `main`, `user-card`, `btn`, `btn-secondary`, `btn-danger`, `chip`, `badge`, `badge--confirmed|in-progress|pending|cancelled|neutral`, `alert`, `alert--info|success|warning|error`, `alert--prominent`, `table-wrap`, `empty`, `field-error`, `triage`, `triage--1…5`, `skip-link`, `is-active`, `is-selected`, `is-busy`.

Los elementos `h1`, `h2`, `button`, `input`, `select`, `textarea`, `label`, `fieldset`, `legend`, `table`, `dl`, `ul.errors` y `a` se estilizan **sin clase**.

## Invariantes que verifica la guardia automática

1. Ningún color literal (`#hex`, `rgb()`, `hsl()`) fuera del bloque `:root` de `styles.css`.
2. Ningún atributo `style=` en el código de las vistas ni en el HTML que producen.
3. Ninguna URL absoluta `http(s)://` en la hoja, en las vistas ni en la plantilla (salvo enlaces de contenido como «Cómo llegar»).
4. Peso total de `styles.css` + fuentes < 300 KB.
5. Todas las parejas texto/fondo declaradas cumplen contraste ≥ 4.5:1 (≥ 3:1 en texto grande).
