# Quickstart: validar el diseño visual

Prerrequisitos: `npm run build`, base de pruebas disponible. Correr vitest por PowerShell con ruta `C:\` (ver memoria del proyecto).

## Automático

1. `npm run lint` y `npm run typecheck` sin errores.
2. `npm run test` completo en verde, incluidas las pruebas nuevas:
   - `tests/unit/design-guards.test.ts`: sin colores fuera de `:root`, sin `style=`, sin URLs externas, peso < 300 KB.
   - `tests/unit/design-tokens.test.ts`: contraste ≥ 4.5:1 en todas las parejas; mapeos de insignias.
   - `tests/contract/assets-routes.test.ts`: `/assets/styles.css` y las dos fuentes responden 200 con caché larga y `nosniff`; `/assets/../x`, `/assets/otro.css` y subdirectorios dan 404 idéntico; CSP sin `https:` ni `unsafe-inline`; límite propio.
   - `tests/contract/design-shell.test.ts`: cada tipo de pantalla enlaza la hoja, tiene `lang="es"`, viewport, salto al contenido, `<main id="contenido">`, un solo `h1` y el pie legal; con sesión hay barra lateral con la navegación del rol, página activa y «Salir»; sin sesión no hay ninguna de las tres.

## Escenarios manuales (con `npm run dev` o en `agendadental.innvend.com`)

Cada uno a **1440 px** y a **390 px**, sin scroll horizontal de la página:

1. **Acceso**: `/login`, `/recuperar`, `/legal`, `/derechos` → tarjeta centrada, un botón primario, errores visibles al enviar vacío.
2. **Micrositio y reserva**: `/c/<slug>` → nombre, dirección con «Cómo llegar», dos opciones; reservar una cita completa; los horarios libres y ocupados se distinguen sin depender del color.
3. **Urgencias** (si están habilitadas): la instrucción de acudir a un hospital o llamar al consultorio es lo más destacado; las categorías de triaje se distinguen por texto y color.
4. **Paciente con sesión**: barra con Inicio, Mis citas y Mis consultorios; «Mis citas» con insignias «Agendada»/«Cancelada»; cancelar es botón de peligro y pide la confirmación de siempre.
5. **Médico**: agenda del día y semana, nueva cita, detalle, bloqueos, configuración, mi micrositio, recepción; la entrada actual resaltada; con la cuenta en solo lectura aparece la alerta informativa.
6. **Recepción**: la navegación no incluye «Configuración».
7. **Soporte**: resumen, médicos (insignias de estado), detalle con formulario de acción (motivo + casilla + advertencia), micrositios, correos, métricas («cumple / no cumple»), historial; las tablas se desplazan dentro de su contenedor.
8. **Errores**: `/ruta-que-no-existe` y un formulario con token vencido usan el diseño común.
9. **Teclado**: Tab recorre cada pantalla con foco visible y en orden; «Saltar al contenido» funciona; Enter envía los formularios.
10. **Reducir movimiento**: con la preferencia activada no hay transiciones.
11. **Privacidad**: en la pestaña de red de las herramientas del navegador, **ninguna** petición sale del dominio `agendadental.innvend.com` (SC-005).
12. **Sin sesión**: ninguna pantalla pública muestra «Salir».

## Despliegue (corte final)

1. Desplegar con el procedimiento actual (`hosting_deploy`); el build copia `src/http/assets` a `dist`.
2. Comprobar `https://agendadental.innvend.com/assets/styles.css` (200, `cache-control` largo) y las dos fuentes.
3. Repetir los escenarios 1, 2 y 11 en producción y registrar capturas en `docs/` (no con datos reales de pacientes).
4. Medir una primera reserva de principio a fin (meta: menos de 2 minutos, SC-007) y la carga del micrositio y del calendario (meta: menos de 2 segundos, SC-006).
