# Contrato: rutas de la página de inicio

| Ruta | Acceso | Entrada | Respuesta |
|---|---|---|---|
| `GET /` | Pub | Ninguna (no lee query ni cuerpo) | Sin sesión o con la sesión a medias: **200** con la portada (`text/html`). Con sesión completa: **303** a la pantalla de inicio del rol (`/pacientes/panel`, `/medicos/inicio`, `/recepcion/panel` o `/soporte/medicos`, la tabla de `/login`) |

Reglas:

- **Límite de peticiones**: 120 por minuto por IP (el global de 300 también aplica); superarlo responde 429 como el resto de pantallas públicas.
- **Cabeceras**: `Cache-Control: no-store` (regla común del HTML), `Content-Security-Policy` estricta de la feature 6 (sin ampliarla), `X-Content-Type-Options: nosniff` y las demás de `helmet`.
- **Sin cookies**: la respuesta no establece ninguna cookie (no hay token CSRF anónimo porque no hay formularios).
- **`HEAD`**: lo atiende el servidor con las mismas cabeceras y sin cuerpo.
- **Filtros globales**: `/` no está exenta de los filtros de avisos legales pendientes ni de activación del segundo factor de soporte. Una persona con sesión completa que tenga avisos por aceptar recibe **303 a `/legal/aceptar`** (y soporte sin el segundo factor, **303 a `/cuenta/mfa/alta`**) antes de la redirección a su área, igual que en las demás pantallas; sin sesión o con la sesión a medias, nunca interviene un filtro.
- **Otras rutas** (`/index.html`, `/inicio`, `/home`): siguen dando el 404 uniforme; solo la raíz es la portada.
- **Sin efectos secundarios**: no escribe en la base, no encola correos, no registra a nadie.
