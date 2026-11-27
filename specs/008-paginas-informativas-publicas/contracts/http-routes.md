# Contrato: rutas de las páginas informativas

| Ruta | Acceso | Entrada | Respuesta |
|---|---|---|---|
| `GET /como-funciona` | Pub | Ninguna (no lee query ni cuerpo) | **200** `text/html` con «Cómo funciona», con o sin sesión; nunca redirige |
| `GET /planes` | Pub | Ninguna | **200** `text/html` con «Planes», con o sin sesión; nunca redirige |
| `GET /nosotros` | Pub | Ninguna | **200** `text/html` con «Nosotros», con o sin sesión; nunca redirige |

`GET /` (feature 7) no cambia de comportamiento: sin sesión o con la sesión a medias muestra la portada (ahora con la barra única); con sesión completa redirige 303 al área del rol.

Reglas:

- **Públicas para todos los roles**: con sesión completa (paciente, médico, recepción o soporte), con la sesión a medias y sin sesión responden 200 con el mismo contenido; la sesión no cambia nada de la página.
- **Filtros globales**: las tres rutas están **eximidas** del filtro de avisos legales pendientes y del de segundo factor de soporte (lista `PUBLIC_INFO_PATHS`), de modo que una persona con avisos por aceptar o soporte sin segundo factor las ve sin ser redirigida. `/` **no** está eximida.
- **Límite de peticiones**: 120 por minuto por IP (el global de 300 también aplica); superarlo responde 429.
- **Cabeceras**: `Cache-Control: no-store` (regla común del HTML), `Content-Security-Policy` estricta de la feature 6 (sin ampliarla), `X-Content-Type-Options: nosniff` y las demás de `helmet`.
- **Sin cookies**: la respuesta no establece ninguna (no hay formularios ni token CSRF).
- **`HEAD`**: lo atiende el servidor con las mismas cabeceras y sin cuerpo.
- **Otras rutas y métodos**: `POST`, `PUT`, `DELETE` y variantes (`/planes/`, `/Planes`, `/como_funciona`, `/precios`, `/about`) siguen dando el 404 uniforme (o el comportamiento habitual del sitio); solo las tres rutas son páginas.
- **Sin efectos secundarios**: no escriben en la base, no encolan correos, no registran a nadie.
- **Marca de la página actual**: en cada ruta, la barra marca con `aria-current="page"` solo su propio enlace.
