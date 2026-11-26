# 0008 — Página de inicio pública (feature 7)

Fecha: 26/11/2026. Estado: vigente. Spec: `specs/007-pagina-de-inicio-publica/`.

## Decisión

`GET /` muestra una portada pública para médicos y consultorios (antes la raíz daba «no encontrado»).

- **Vista propia sin el shell** (`src/http/views/landing.ts`): tiene su cabecera, secciones de ancho completo y pie; no usa `page()` ni emite las marcas del shell, así que nunca lleva barra lateral ni «Salir». El `<head>` común (hoja, fuentes, `noindex`, viewport, título) se extrajo a `documentHead()` en `layout.ts` y lo comparten `page()` y la portada.
- **Ruta mínima** (`src/modules/home/home-routes.ts`): sin entrada y sin consultas a la base. Con sesión completa responde 303 al inicio del rol (la tabla `HOME_BY_ROLE` de `/login`); sin sesión o con la sesión a medias, la portada. Límite de 120 peticiones por minuto por IP. Sin cookies.
- **Destinos**: «Registrarme» y los dos «Regístrate aquí» → `/medicos/registro`; «Iniciar sesión» y «Ya tengo cuenta» → `/login`; pie → `/legal/doctor_privacy`, `/legal/terms_doctor` y `mailto:` al `RIGHTS_CONTACT_EMAIL` (el buzón público, no el interno de nuevos médicos).
- **Texto veraz** (la imagen de referencia prometía reprogramar, mensajería, recordatorios automáticos y rentabilidad, que el piloto no tiene): se reescribió con lo que sí existe y una prueba (`tests/unit/landing-copy.test.ts`) falla si reaparece un término prohibido (reprogramar, WhatsApp, mensajería, rentabilidad, precios, «gratis», «garantía», «satisfechos»…).
- **Sin indexar** durante el piloto (`noindex` del `<head>` común); abrirla después es un cambio de una línea en `documentHead()`.
- **Sin caché de la página** (regla común del HTML): la misma URL redirige o muestra la portada según la cookie de sesión.
- **Año del pie** en UTC (en la noche de fin de año en México puede adelantarse unas horas).
- Con avisos legales pendientes o soporte sin segundo factor, los filtros globales intervienen antes de la redirección, igual que en el resto del sitio.

## Dependencia aceptada

Mientras los textos legales de médico (`doctor_privacy` y `terms_doctor`) sean provisionales, el registro de médicos **no está abierto en producción**: enviar el formulario responde con el aviso «El registro todavía no está disponible: estamos terminando la revisión legal de nuestros avisos». La portada se publica igualmente; el registro se abre cuando un abogado revise esos textos y se publiquen (`npm run legal:publish`). Avisarlo antes de llenar el formulario es una mejora aparte.

## Riesgos abiertos

- La portada invita a registrarse a cualquiera; soporte sigue aprobando cada solicitud a mano (y la banda lo dice).
- La verificación visual a 390 y 1440 px y con teclado es manual.
