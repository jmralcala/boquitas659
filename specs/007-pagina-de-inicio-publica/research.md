# Research: Página de inicio pública

Las decisiones de producto ya están en la spec (destinos de los botones, texto veraz, sin indexar). Aquí se resuelve **cómo**. No quedan `NEEDS CLARIFICATION`.

## 1. Cómo se arma el documento sin usar el shell

- **Decision**: se extrae de `layout.ts` una función `documentHead({ title, description? })` que emite el `<head>` común (charset, viewport, `noindex`, `<title>`, precarga de las dos fuentes, hoja de estilos con `?v=<hash>`); `page()` la usa y la portada también. La portada escribe su propio `<body>` **sin** las marcas `<!--shell:open/close-->`, así que el gancho de `shell.ts` (que solo actúa si encuentra las marcas) la deja intacta, incluso con la sesión a medias.
- **Rationale**: evita duplicar el `<head>` (hoja, fuentes, `noindex`) y que se desincronice; la portada hereda de golpe cualquier cambio futuro del `<head>`.
- **Alternatives**: `page()` con una opción «sin shell» (mezcla dos estructuras en una función y deja el cuerpo dentro de `<main>` con pie legal propio); HTML completo copiado (duplicación).

## 2. Ruta y redirección

- **Decision**: `GET /` en `src/modules/home/home-routes.ts`. Si `isFullyAuthenticated(request.auth)`, responde **303** a `HOME_BY_ROLE[rol]` (exportada de `modules/auth/routes.ts`, la misma tabla que usa `/login`); en otro caso envía la portada. Límite de peticiones por IP de 120 por minuto, como el micrositio público. Sin entrada: no lee query, cuerpo ni cabeceras de negociación (siempre HTML).
- **Rationale**: reutiliza la lógica existente; con sesión a medias no redirige (igual que `/login`, que ya resuelve ese caso).
- **Alternatives**: redirigir siempre a `/login` (rompe la portada); duplicar la tabla de inicios por rol (riesgo de desincronización).

## 3. Datos dinámicos de la vista

- **Decision**: la vista recibe `year` (de `services.clock.now()`) y `contactEmail` (de `services.env.RIGHTS_CONTACT_EMAIL`); ambos se interpolan con el escape habitual de `html`. El enlace «Contacto» es `mailto:<correo>` y, por accesibilidad, el texto visible es «Contacto» con la dirección en un `title`/descripción accesible para poder copiarla si no hay cliente de correo (caso límite de la spec).
- **Rationale**: el año no queda fijo en el código y se puede probar con el reloj de pruebas; el correo público ya está configurado y validado como `z.email()`.
- **Alternatives**: año fijo «2026» (se queda viejo); publicar `SUPPORT_EMAIL` (es interno).

## 4. Destinos de los enlaces del pie

- **Decision**: «Aviso de privacidad» → `/legal/doctor_privacy`; «Términos y condiciones» → `/legal/terms_doctor` (los mismos que enlaza el registro de médicos); «Contacto» → `mailto:`. Los enlaces legales abren en la misma pestaña (la portada no es un formulario que se pierda).
- **Rationale**: la audiencia es médicos; son los textos que ya existen y aceptan al registrarse.

## 5. Íconos y estilo

- **Decision**: íconos de trazo propios nuevos en `icons.ts` (`timer`, `bell`, `shield`, `arrow-right`, `log-in`) reutilizando `calendar` y `success` de la feature 6 y el logo existente; todos `aria-hidden`. Estilos de la portada en la misma `styles.css`: `.landing` como contenedor, `.topbar`, `.hero`, `.features` (rejilla `repeat(auto-fit, minmax(220px, 1fr))`), `.feature`, `.cta-band` (fondo `--color-primary`, texto `--color-on-primary`, botón blanco con `--color-surface`) y `.landing-footer`. Anchos de contenido con `max-width` de 1200 px centrado; sin valores de color nuevos fuera de `:root` (si hace falta un tono, se añade el token).
- **Rationale**: sin librerías ni imágenes (la referencia solo usa texto, íconos y color); la guardia de la feature 6 sigue protegiendo la hoja.

## 6. Texto veraz y su verificación

- **Decision**: los textos definitivos están en [contracts/page-content.md](contracts/page-content.md). Una prueba unitaria renderiza la portada, extrae el texto visible y falla si aparece cualquiera de los **términos prohibidos** (reprogram, whatsapp, mensajer, rentabil, precio, gratis, plan, descuento, garant, «satisfech»…); y una segunda comprueba que cada tarjeta y frase clave de la lista de capacidades está presente.
- **Rationale**: convierte «la portada no promete lo que no hay» (FR-009, SC-003) en una prueba que se rompe si alguien reintroduce una promesa.
- **Alternatives**: solo revisión humana (se olvida).

## 7. Caché

- **Decision**: la portada sigue la regla común de las páginas HTML (`Cache-Control: no-store`); la hoja de estilos y las fuentes ya llevan caché de un año.
- **Rationale**: la misma URL redirige o muestra la portada según la cookie de sesión; cachearla exigiría `Vary: Cookie` y complicaría las pruebas por un ahorro mínimo (HTML < 30 KB).

## 8. Indexación

- **Decision**: se conserva `<meta name="robots" content="noindex">` del `<head>` común (decisión de la persona responsable para el piloto). La vista expone el valor en un solo punto para poder abrirla después sin tocar el resto.

## 9. Pruebas existentes que hay que ajustar

- `tests/integration/route-audit.test.ts`: incluye el contrato de la 007 en `CONTRACT_FILES` y `/` en `PUBLIC_GET`.
- `tests/contract/design-shell.test.ts` (recorrido de todas las rutas): la portada debe cumplir hoja, `lang`, viewport, `noindex`, «Saltar al contenido», `<main id="contenido">` y no llevar `style=`; su **pie** es el propio de la portada (enlace al aviso de privacidad de médicos, no el pie común), así que el chequeo de pie legal acepta `/legal/doctor_privacy` además de `/legal`. La portada tampoco lleva barra lateral ni «Salir» (no usa el shell), verificado en su propia prueba.
- `tests/contract/design-a11y.test.ts` y `tests/unit/design-guards.test.ts` la cubren sin cambios (un solo `h1`, etiquetas, sin colores sueltos ni URLs externas; el `mailto:` no es `http(s)`).

## 10. Despliegue

- Sin cambios de configuración: mismo procedimiento (`hosting_deploy`). Verificación en producción: `https://agendadental.innvend.com/` responde 200 con la portada, sus cuatro botones llevan a los destinos y la redirección con sesión funciona.
