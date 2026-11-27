# Investigación (Fase 0): páginas informativas públicas

Fecha: 27/11/2026. No quedan puntos «NEEDS CLARIFICATION»: las dos decisiones abiertas (vigencia del descuento y aclaración del cobro) se resolvieron en la spec.

## D1. Marco público compartido en lugar de copiar la cabecera

- **Decisión**: `src/http/views/public-site.ts` exporta `publicDocument({ current, title, description, main, year, contactEmail })` que devuelve el HTML completo (`<!doctype>`, `documentHead`, `<body class="landing">`, salto al contenido, barra única, `<main id="contenido">`, pie). `landing.ts` y las tres vistas nuevas solo aportan su `<main>`.
- **Por qué**: FR-001 exige una barra idéntica en las cuatro páginas; con un solo origen la prueba de «barra idéntica» es trivial y no se desincroniza. Reusa el `<body class="landing">` para heredar fondo y pie de la portada, y las guardias de diseño existentes la reconocen.
- **Alternativas**: copiar la cabecera en cada vista (se desincroniza); usar `page()` (trae la barra lateral y la tarjeta centrada, que no sirven para páginas de ancho completo; descartado ya en la feature 7).

## D2. Menú sin JavaScript

- **Decisión**: una `<nav aria-label="Principal">` con un grupo de menú (`<ul>` de cuatro enlaces) y un grupo de acceso («Registrarme» e «Iniciar sesión»). El tema ya usa `flex-wrap`; en pantallas estrechas la barra pasa a dos o tres filas, cada enlace con altura táctil ≥ 44 px. Página actual: `aria-current="page"` y un estilo propio (no solo color: subrayado grueso).
- **Por qué**: son solo seis destinos; un menú desplegable (`<details>`) añade un clic extra a casi todas las visitas y complica el orden de tabulación.
- **Alternativa**: `<details>` con hamburguesa (descartada por lo anterior; queda como mejora si el menú crece).

## D3. Fuente única de precios y cálculo con enteros

- **Decisión**: `plans.ts` guarda `priceMxn` (499, 999, 1999) y `DISCOUNT_PERCENT = 30`; `priceWithDiscount = Math.floor((priceMxn * (100 - DISCOUNT_PERCENT) + 50) / 100)` → 349, 699, 1399; `formatMxn(pesos)` arma `$1,399` a mano (sin depender de `Intl`, que en hosting compartido puede variar).
- **Por qué**: FR-016 pide que el descuento se calcule y no se escriba a mano; los enteros evitan errores de coma flotante. Decisión del 27/11/2026: los precios con descuento se muestran **sin centavos**, redondeados al peso más cercano (499 × 0.7 = 349.3 → 349; 999 × 0.7 = 699.3 → 699; 1999 × 0.7 = 1399.3 → 1399). Los tres quedan 30 centavos por debajo del 70 % exacto, a favor del cliente; si cambia un precio, la regla se aplica igual.
- **Alternativa**: guardar los seis montos fijos (se desincroniza si cambia el porcentaje).
- **Formato**: todos los montos sin centavos (`$499`, `$349`, `$1,999`, `$1,399`).

## D4. Veracidad: qué se afirma y qué no

- Fuentes verificadas: `docs/decisions/0001`–`0008`, specs 1–7 y la implementación. Capacidades del piloto: micrositio `/c/nombre` con «Cómo llegar», teléfono y logo; agenda por día/semana; horarios, duración, pausa, bloqueos y anticipación mínima y máxima configurables; reserva sin dobles reservas; cancelación del paciente hasta 24 h antes (configurable) y del médico con aviso por correo; correos de confirmación y recordatorio con enlace; personal de recepción; separación de datos por consultorio; aviso de privacidad con consentimiento expreso; revisión de cada solicitud de médico por soporte (cédula e identificación oficial).
- **No se afirma**: reprogramación, WhatsApp disponible, cobro o pago en línea, urgencias en línea (validación de dentista pendiente), historial clínico, rentabilidad, cifras de mejora, testimonios.
- **Planes**: los topes de WhatsApp (30, 400 y 1,200) se publican **solo con «Próximamente»**; el cobro del exceso (1 peso, tope de 100) **no** se publica.
- Una prueba unitaria por página codifica esta lista (D8).

## D5. Rutas públicas sin redirección y filtros globales

- **Hallazgo**: `legal-gate.ts` y `support-mfa.ts` redirigen a quien tiene avisos pendientes o a soporte sin segundo factor en **cualquier** ruta no eximida. `/` no está eximida a propósito (redirige al área). Para que las tres páginas se vean con o sin sesión (spec, SC-009), deben eximirse.
- **Decisión**: `src/http/public-paths.ts` exporta `PUBLIC_INFO_PATHS = ["/como-funciona", "/planes", "/nosotros"]`; ambos `isExempt` la consultan. `/` **no** se exime (sigue redirigiendo).
- **Riesgo**: ninguno de seguridad: las páginas no leen sesión, datos ni entrada.

## D6. Enlace externo a Innvend

- **Decisión**: `<a href="https://www.innvend.com" target="_blank" rel="noopener noreferrer">www.innvend.com</a>`, más `mailto:contacto@innvend.com` y `tel:+523312415547`, con el texto visible.
- **Hallazgo**: la guardia de recursos externos (`design-guards.test.ts`) ya ignora direcciones con `innvend.com`; **no necesita cambios** y sigue detectando cualquier otro dominio. La que sí cambia es la aserción `not.toMatch(/https?:\/\/(?!www\.w3\.org)/)` de `landing.test.ts`, que se mantiene para la portada y las dos páginas sin enlaces externos; en «Nosotros» se afirma que el único dominio externo es `www.innvend.com`.
- **CSP**: no cambia (los enlaces de navegación no son recursos).

## D7. Íconos y estilos

- Íconos nuevos propios (trazo, `currentColor`, decorativos): `check` (listas de planes y funcionalidades) y `phone`. Se reutilizan `calendar`, `success`, `timer`, `bell`, `shield`, `users`, `globe`, `building`, `mail`, `arrow-right`, `log-in`.
- Estilos en `styles.css` con tokens de `:root`: encabezado de página (`.page-hero`), rejilla de beneficios, lista de pasos numerados (`ol.steps`), rejilla de planes (`.plans`, 1 columna en celular y 3 desde ~900 px), precio (`.price__old` con `text-decoration: line-through`, `.price__now`), insignias («30 % de descuento», «Próximamente»), bloque de nota y tarjeta «Nosotros». La guardia contra `style=` y colores fuera de `:root` sigue vigente.

## D8. Pruebas

- `tests/unit/plans.test.ts`: cálculo del 70 %, formato MXN, montos acordados (499→349, 999→699, 1999→1399).
- `tests/unit/info-copy.test.ts`: por página, términos prohibidos (reprogram, rentabil, ganancia, ingreso, garant, satisfech, testimonio, lider, `%` salvo «30 %» en «Planes», «gratis», «urgencia» salvo el tope en «Planes»); `WhatsApp` solo en «Planes» y siempre dentro de un elemento «Próximamente»; no aparece el exceso «1 peso».
- `tests/contract/info-pages.test.ts`: 200 con y sin sesión (4 roles + a medias), barra idéntica salvo `aria-current`, destinos, tres precios tachados y tres con descuento, leyendas de promoción y cobro, enlace de Innvend con `noopener noreferrer`, un solo `<h1>`, sin `<form>`, `<script>`, `style=`, cookies; `HEAD`, 404 de variantes y peso < 30 KB.
- Se ajustan: `landing.test.ts` (barra única), `landing-copy.test.ts` (el menú no cuenta), `route-audit.test.ts` (contrato 008, rutas públicas) y el recorrido de `design-shell`/`design-a11y` (las rutas nuevas deben cumplir `expectDesigned`).
