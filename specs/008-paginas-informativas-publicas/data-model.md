# Modelo de contenido (Fase 1)

No hay datos persistentes: sin tablas, migraciones ni variables de entorno. El contenido vive en el código de las vistas (`src/http/views/`).

## Plan (`plans.ts`)

| Campo | Tipo | Regla |
|---|---|---|
| `id` | `"esencial" \| "profesional" \| "elite"` | Orden de la página: Esencial, Profesional, Élite |
| `name` | texto | «Esencial», «Profesional», «Élite» |
| `priceMxn` | entero | 499, 999 y 1999 (pesos MXN, IVA incluido, por mes) |
| `trialDays` | entero \| `null` | Esencial: 5; Profesional y Élite: `null` (sin prueba) |
| `whatsappAllowance` | texto | «30 avisos de urgencia por WhatsApp al mes», «400 mensajes de WhatsApp al mes», «1,200 mensajes de WhatsApp al mes»; siempre se muestran con «Próximamente» |

Constante `DISCOUNT_PERCENT = 30` (igual para los tres planes).

Funciones puras:

- `priceWithDiscount(priceMxn)` = `Math.floor((priceMxn * (100 - DISCOUNT_PERCENT) + 50) / 100)` (70 % redondeado al peso más cercano, con enteros) → 349, 699, 1399.
- `formatMxn(pesos)` → `$499` / `$349` / `$1,399` (sin centavos; separador de miles con coma).

Invariantes: `priceWithDiscount(plan) < plan.priceMxn`; y `|priceWithDiscount(plan) − priceMxn × 0.70| ≤ 0.5` (a lo sumo medio peso de redondeo; para los tres precios acordados queda por debajo del 70 % exacto en $0.30).

## Entrada de menú (`public-site.ts`)

| Campo | Tipo | Valores |
|---|---|---|
| `key` | `"inicio" \| "como-funciona" \| "planes" \| "nosotros"` | Identifica la página actual para `aria-current` |
| `label` | texto | «Inicio», «Cómo funciona», «Planes», «Nosotros» |
| `href` | ruta | `/`, `/como-funciona`, `/planes`, `/nosotros` |

Acciones de acceso (no son entradas del menú): «Registrarme» → `/medicos/registro` e «Iniciar sesión» → `/login`.

## Parámetros de las vistas

`publicDocument({ current: MenuKey, title, description, main: SafeHtml, year: number, contactEmail: string })`. Los únicos valores dinámicos son `year` (reloj del servicio, UTC) y `contactEmail` (`RIGHTS_CONTACT_EMAIL`); ambos se escapan.
