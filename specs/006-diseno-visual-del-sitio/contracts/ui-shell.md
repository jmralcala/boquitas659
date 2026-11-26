# Contrato: estructura de página (shell)

## Plantilla común (`views/layout.ts`)

`page({ title, content })` **conserva su firma**. Todo documento HTML que produce cumple:

- `<html lang="es">`, `<meta charset>`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<meta name="robots" content="noindex">`, `<title>` con el título de la pantalla.
- Un único `<link rel="stylesheet" href="/assets/styles.css?v=<hash>">` (ningún otro origen) y la precarga de las dos fuentes (`<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/fonts/...">`).
- Enlace «Saltar al contenido» como primer elemento del `<body>` (`href="#contenido"`).
- Las marcas `<!--shell:open-->` y `<!--shell:close-->` rodean `<main id="contenido">` y el pie.
- El pie con el aviso de privacidad y el canal de derechos **siempre** presente (FR-019).
- Exactamente un `<h1>` por pantalla.

Las páginas de error (403, 404, 500, formulario vencido) se generan con esta misma plantilla, no con HTML propio.

## Gancho de respuesta (`http/shell.ts`)

Se ejecuta en `onSend` sobre respuestas `text/html` que contengan las marcas (las demás pasan intactas).

| Situación | Resultado |
|---|---|
| **Sin sesión** | `<body class="card-page">`: tarjeta centrada, sin barra lateral, sin «Salir». |
| **Con sesión completa** | `<body class="has-shell">` con: `.app` → `aside.sidebar` (logo + «Agenda Dental», `nav[aria-label="Principal"]` del rol, `.user-card` con la etiqueta del rol y el formulario `POST /logout` con `_csrf` de la sesión) + `.main` (contenido y pie). |
| **Con sesión a medias** (segundo factor pendiente o avisos legales por aceptar) | Igual, pero **sin `nav`**: solo logo, tarjeta de usuario y «Salir» (los enlaces de la navegación redirigirían). |
| **Cuenta en solo lectura** | Además, alerta informativa `.alert.alert--info[role=status]` al inicio del contenido (sustituye al párrafo actual; mismo texto). |

Reglas:

- La navegación sale de la tabla por rol de [data-model.md](../data-model.md) §4; `request.auth.role` decide cuál. Una entrada no se muestra si el rol no la tiene hoy (por ejemplo «Configuración» para recepción).
- La entrada activa lleva `aria-current="page"` y la clase `is-active`; el prefijo de ruta más largo gana.
- Las pantallas del consultorio (`/c/:slug/...`) que abre una persona con sesión (un paciente en la reserva, o el personal que revisa el micrositio) usan la estructura con la barra de **su** rol; sin sesión, la tarjeta centrada.
- **Limitación conocida**: la sesión no trae el estado de aprobación del médico, así que un médico aún no aprobado o suspendido ve la navegación completa; sus enlaces dan el 403 o la pantalla de estado de siempre, ya con el diseño común.
- Sin sesión nunca se emite la tarjeta de usuario, el formulario de «Salir» ni el token CSRF de sesión (el botón no aparece en `/login`, `/legal` ni en el micrositio público).
- El gancho **no** añade estilos en línea ni scripts, y no hace consultas a la base.
- `Cache-Control: no-store` de las páginas HTML se conserva (el gancho no lo toca).

## Cambios que este contrato retira

- El `<nav aria-label="Agenda">` de `calendarLayout` y el `<nav aria-label="Panel de soporte">` de `supportPage` (la navegación pasa al shell).
- El `<nav aria-label="Sesión">` con «Salir» insertado hoy por `app.ts` (la salida pasa a la tarjeta de usuario). La prueba `logout-button.test.ts` se actualiza al nuevo lugar.

## Responsive

- ≥ 800 px: barra lateral de 248 px a la izquierda; contenido a la derecha.
- < 800 px: la barra lateral pasa arriba; la navegación es una fila con desplazamiento horizontal dentro de su contenedor; la tarjeta de usuario queda en una línea compacta.
- En ningún ancho entre 390 y 1440 px la página tiene desplazamiento horizontal.
