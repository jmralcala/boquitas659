# Modelo de contenido: Página de inicio pública

Esta feature **no añade ni lee datos persistentes** (sin tablas, migraciones ni consultas). El «modelo» es la estructura fija de la página y los pocos valores dinámicos.

## Estructura de la página (de arriba abajo)

| # | Bloque | Elemento HTML | Contenido |
|---|---|---|---|
| 0 | Salto al contenido | `a.skip-link` | «Saltar al contenido» |
| 1 | Barra superior | `header.topbar` con `nav` | Logo + «Agenda Dental» (enlace a `/`), enlace «Registrarme» (`/medicos/registro`), botón con borde «Iniciar sesión» con ícono `log-in` (`/login`) |
| 2 | Sección principal | `main#contenido > section.hero` | Etiqueta, `h1` de dos líneas, párrafo y dos botones |
| 3 | Beneficios | `section.benefits` | `h2`, introducción y 5 tarjetas (`ul.features > li.feature`) con ícono decorativo |
| 4 | Llamada a la acción | `section.cta-band` | `h2`, texto y botón blanco «Regístrate aquí» (`/medicos/registro`) |
| 5 | Pie | `footer.landing-footer` | «© {año} Agenda Dental» y enlaces «Aviso de privacidad», «Términos y condiciones», «Contacto» |

## Valores dinámicos

| Valor | Origen | Uso | Escape |
|---|---|---|---|
| `year` | `services.clock.now()` (año UTC) | «© {año} Agenda Dental» | número |
| `contactEmail` | `env.RIGHTS_CONTACT_EMAIL` (validado como correo, por defecto `soporte@innvend.com`) | `href="mailto:…"` de «Contacto» | `html` escapa el valor |

El resto del contenido es texto fijo en español ([contracts/page-content.md](contracts/page-content.md)).

## Enlaces de acción y destinos

| Texto | Lugar | Destino | Variante visual |
|---|---|---|---|
| Registrarme | barra superior | `/medicos/registro` | enlace de texto |
| Iniciar sesión | barra superior | `/login` | botón con borde (secundario) |
| Regístrate aquí | sección principal | `/medicos/registro` | botón primario con flecha |
| Ya tengo cuenta | sección principal | `/login` | botón secundario |
| Regístrate aquí | banda final | `/medicos/registro` | botón blanco |
| Logo + «Agenda Dental» | barra superior | `/` | enlace |
| Aviso de privacidad | pie | `/legal/doctor_privacy` | enlace de pie |
| Términos y condiciones | pie | `/legal/terms_doctor` | enlace de pie |
| Contacto | pie | `mailto:{contactEmail}` | enlace de pie |

## Íconos (nuevos en `icons.ts`, de trazo, decorativos)

`timer`, `bell`, `shield`, `arrow-right`, `log-in`; se reutilizan `calendar`, `success` (2.ª tarjeta) y el logo de la feature 6.

| Tarjeta | Ícono |
|---|---|
| 1. Planear la semana | `calendar` |
| 2. Sin dobles reservas | `success` |
| 3. Cumplir los tiempos | `timer` |
| 4. Recordatorios por correo | `bell` |
| 5. Datos separados por consultorio | `shield` |
