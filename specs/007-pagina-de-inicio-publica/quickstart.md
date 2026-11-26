# Quickstart: validar la página de inicio

Prerrequisitos: `npm run build`; la base de pruebas disponible. Correr vitest por PowerShell con ruta `C:\` (no dos corridas a la vez: comparten la base).

## Automático

1. `npm run lint` y `npm run typecheck` sin errores.
2. Pruebas nuevas en verde:
   - `tests/contract/landing.test.ts`: `GET /` sin sesión responde 200 con el texto de [contracts/page-content.md](contracts/page-content.md); 3 enlaces a `/medicos/registro` y 2 a `/login` con los nombres correctos; el pie con los dos textos legales y `mailto:`; un solo `h1`; sin `<form>` ni `<input>`; sin `style=`, sin `<script>` y sin URLs `http(s)` externas; `noindex` presente; sin `Set-Cookie`; `Cache-Control: no-store`; el año es el del reloj; con sesión completa de cada rol (4) responde 303 al inicio del rol; con la sesión a medias muestra la portada; no tiene barra lateral ni «Salir».
   - `tests/unit/landing-copy.test.ts`: ningún término prohibido en el texto visible y todas las frases de capacidades presentes; el HTML pesa menos de 30 KB.
3. Suite existente en verde, incluidas `route-audit` (la raíz está en el contrato y es pública), `design-shell`, `design-a11y` y `design-guards`.

## Manual (en `npm run dev` o en `agendadental.innvend.com`)

1. Abrir `/` sin sesión: se ve la portada completa de la referencia (barra, sección principal, 5 tarjetas, banda, pie) a **1440 px** y a **390 px**, sin desplazamiento horizontal.
2. Pulsar «Registrarme», «Regístrate aquí» (sección principal) y «Regístrate aquí» (banda): los tres abren el registro de médicos.
3. Pulsar «Iniciar sesión» y «Ya tengo cuenta»: abren el inicio de sesión.
4. Iniciar sesión como cada rol y abrir `/`: redirige al área del rol, sin ver la portada.
5. Pie: «Aviso de privacidad» y «Términos y condiciones» abren los textos de médico; «Contacto» abre un correo a `soporte@innvend.com`.
6. Teclado: Tab recorre barra, botones, tarjetas (no son enlaces), banda y pie, con foco visible; «Saltar al contenido» funciona.
7. Pestaña de red: ninguna petición fuera de `agendadental.innvend.com`; ninguna cookie nueva.
8. Revisar el texto contra la lista de capacidades (nada de reprogramar, WhatsApp, precios ni resultados).
9. **Dependencia conocida**: con los textos legales de médico aún provisionales, enviar el formulario de registro en producción responde con el aviso «El registro todavía no está disponible: estamos terminando la revisión legal…» (no es un fallo de la portada). Al publicar los textos revisados, el registro se abre.

## Despliegue

1. Desplegar con el procedimiento actual (`hosting_deploy`).
2. Comprobar `https://agendadental.innvend.com/` (200, portada), los cinco destinos y la redirección con sesión.
3. Medir la carga de la portada (meta: menos de 2 s).
