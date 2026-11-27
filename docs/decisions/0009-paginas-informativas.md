# 0009 — Páginas informativas públicas (feature 8)

Fecha: 27/11/2026. Estado: vigente. Spec: `specs/008-paginas-informativas-publicas/`.

## Decisión

Se añaden tres páginas públicas, `GET /como-funciona`, `GET /planes` y `GET /nosotros`, y la barra superior de la portada pasa a ser la **barra de menú única** del sitio público (Inicio, Cómo funciona, Planes, Nosotros, más «Registrarme» e «Iniciar sesión»).

- **Marco compartido** (`src/http/views/public-site.ts`): `publicDocument()` arma el documento (barra, `<main>`, pie) para la portada y las tres páginas; la barra es idéntica por construcción y solo cambia `aria-current`. Sin barra lateral ni marcas del shell.
- **Menú sin JavaScript**: una sola `<nav aria-label="Principal">` con menú y acceso; en pantallas estrechas se acomoda en filas.
- **Rutas mínimas** (`src/modules/home/info-routes.ts`): contenido fijo, sin entrada, sin base de datos (el handler no usa `services.db`), sin cookies, 120 peticiones por minuto por IP. No redirigen con sesión.
- **Exención de filtros globales** (`src/http/public-paths.ts`): las tres rutas se eximen del filtro de avisos legales pendientes y del de segundo factor de soporte, para verse con o sin sesión. `/` sigue redirigiendo.
- **Planes desde una fuente única** (`src/http/views/plans.ts`): precios $499, $999 y $1,999 (IVA incluido, por mes); descuento de 30 % calculado con enteros y **redondeado al peso**: $349, $699 y $1,399 (sin centavos, decisión del 27/11/2026).
- **Promoción** sin fecha de vigencia y sujeta a cambio; WhatsApp solo como «Próximamente»; aclaración de que durante el piloto no hay cobro. Todo **provisional hasta la revisión de Jurídico y Contabilidad** (paquete legal, sección 7.2 bis).
- **Enlace externo acotado**: `https://www.innvend.com` solo en `about.ts` (con `noopener noreferrer`); la guardia de recursos externos de la feature 6 se endureció para admitir exactamente esa dirección en ese archivo.
- Sin indexar (`noindex`) y sin caché, como la portada. Sin migraciones, variables de entorno ni cron nuevos.

## Pruebas

`tests/unit/plans.test.ts` (cálculo y formato), `tests/unit/info-copy.test.ts` (veracidad por página), `tests/contract/info-pages.test.ts` (contenido, barra idéntica, públicas para todos los roles, exención, 429), ajustes a `landing`, `landing-copy`, `route-audit` y `design-guards`.

## Pendientes manuales

- [ ] Revisión visual a 390 px y 1440 px (sin desplazamiento horizontal; botones y enlaces del menú de al menos 44 px).
- [ ] Contraste de 4.5:1 y foco visible; recorrido con teclado (logo → menú → Registrarme → Iniciar sesión → contenido).
- [ ] Lector de pantalla: el precio tachado se lee como «Precio anterior» y el nuevo como «Precio con descuento»; la marca y «Inicio» son dos enlaces seguidos a `/` (intencional).
- [ ] Tiempo de carga menor a 2 s en producción.
- [ ] Validación de Jurídico y Contabilidad de precios, descuento, topes y aclaración del cobro.

## Verificación de los recorridos de diseño

`design-shell` y `design-a11y` recorren las rutas nuevas sin cambios (el cuerpo `landing` y el pie de la portada ya cumplían `expectDesigned`).
