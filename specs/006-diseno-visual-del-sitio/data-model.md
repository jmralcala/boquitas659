# Modelo de diseño: Diseño visual del sitio

Esta feature **no añade ni cambia datos persistentes** (sin migraciones, sin tablas). Lo que se modela es el **sistema de diseño**: tokens, componentes, mapeos de estado y navegación por rol.

## 1. Tokens (definidos una sola vez en `:root` de `styles.css`)

| Grupo | Tokens | Valores de referencia |
|---|---|---|
| Color de marca | `--color-primary`, `--color-primary-hover`, `--color-primary-strong`, `--color-mint`, `--color-mint-2` | `#0B7A72`, `#08635D`, `#0A6B64`, `#E3F4F1`, `#CFE9E5` |
| Color de estado | `--color-sky` / `--color-sky-text`, `--color-amber` / `--color-amber-text`, `--color-red` / `--color-red-text`, `--color-neutral` / `--color-neutral-text` | `#E5F0FA`/`#1E5A8C`, `#FFF3E0`/`#8A4B00`, `#FDECEC`/`#A12727`, `#F1F4F4`/`#4F6B6F` |
| Compuestos | `--color-on-primary` (texto sobre el primario), `--color-nav-hover` | `#FFFFFF`, `#EEF5F4` |
| Texto | `--color-text`, `--color-text-2`, `--color-text-muted`, `--color-nav` | `#0F2A2E`, `#24403F`, `#4F6B6F`, `#3E5A5E` |
| Superficies | `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-border`, `--color-border-input`, `--color-divider` | `#F4F8F8`, `#FFFFFF`, `#F8FBFB`, `#DCE7E7`, `#C9DADA`, `#EDF3F3` |
| Triaje (nuevo; el dato `tone` 1 a 5 reemplaza al campo `color` de `triage-content.ts`) | `--triage-N` (borde), `--triage-N-bg` (fondo suave) y `--triage-N-text` (texto), para N = 1 a 5 | bordes `#C0392B`, `#E67E22`, `#D4AC0D`, `#7DCEA0`, `#27AE60` (los de antes); fondos y textos con contraste ≥ 4.5:1 |
| Tipografía | `--font-body`, `--font-heading` | Inter y Manrope con pila de respaldo del sistema |
| Forma | `--radius-sm` 9px, `--radius-md` 10px, `--radius-lg` 14px, `--radius-xl` 16px, `--radius-pill` 999px | |
| Espaciado | `--space-1` … `--space-8` (4 px a 32 px) | |
| Control | `--control-h` 44px, `--shadow-sm`, `--focus-ring` | |

Regla: ninguna otra parte de la hoja (ni de las vistas) contiene un color literal. Tokens de uso compuesto (por ejemplo el fondo de hover de la navegación) también se declaran aquí.

## 2. Componentes

| Componente | Marcado base | Variantes / estados |
|---|---|---|
| Estructura de página | `body` con el contenedor `.app` (barra lateral + `.main`) o `.card-page` (sin sesión) | con sesión / sin sesión |
| Tarjeta | `.card` (+ cabecera con `h2` y acciones) | — |
| Botón | `button` y `a.btn` | primario (por defecto), `.btn-secondary`, `.btn-danger`, deshabilitado |
| Campo | `label` + `input`/`select`/`textarea`; `fieldset` + `legend` para grupos | foco, error (`ul.errors[role=alert]` o `.field-error`), deshabilitado |
| Chip de opción | `.chip` (+ `aria-pressed`) | activo |
| Tabla | `.table-wrap > table` con `th scope="col"` | fila con hover; sin cebra |
| Insignia | `.badge.badge--<variante>` con punto y texto | `confirmed`, `in-progress`, `pending`, `cancelled`, `neutral` |
| Aviso | `.alert.alert--<variante>` con ícono y texto | `info`, `success`, `warning`, `error`; `.alert--prominent` para urgencias |
| Lista de pares | `dl` con filas `dt`/`dd` | — |
| Estado vacío | `.empty` con título, texto y botón si existe la acción | — |
| Navegación | `nav[aria-label="Principal"] a` | activo: `aria-current="page"` |
| Tarjeta de usuario | `.user-card` con rol y botón «Salir» (`POST /logout`) | — |
| Triaje | `.triage.triage--<id>` con texto de la categoría | 5 categorías |

## 3. Mapeo de estado → insignia (FR-009)

| Dominio | Estado existente | Variante | Texto |
|---|---|---|---|
| Cita | agendada | `confirmed` | Agendada |
| Cita | cancelada | `cancelled` | Cancelada |
| Médico (aprobación) | aprobado | `confirmed` | Aprobado |
| Médico (aprobación) | pendiente | `pending` | Pendiente |
| Médico (aprobación) | rechazado | `cancelled` | Rechazado |
| Médico (cuenta) | activa | `confirmed` | Activa |
| Médico (cuenta) | solo lectura | `in-progress` | Solo lectura |
| Médico (cuenta) | suspendida | `cancelled` | Suspendida |
| Micrositio | publicado | `confirmed` | Publicado |
| Micrositio | borrador | `pending` | Borrador |
| Micrositio | despublicado | `neutral` | Despublicado |
| Correo | enviado | `confirmed` | Enviado |
| Correo | pendiente | `pending` | Pendiente |
| Correo | fallido | `cancelled` | Fallido |
| Correo | cancelado | `neutral` | Cancelado |
| Métrica | cumple | `confirmed` | Cumple |
| Métrica | no cumple | `cancelled` | No cumple |
| Métrica | sin datos | `neutral` | Sin datos |

Los textos de estado que la app ya muestra no cambian; la insignia los envuelve.

## 4. Navegación por rol (solo enlaces existentes)

| Rol | Entradas (ruta → etiqueta) |
|---|---|
| Médico | `/medicos/inicio` Inicio · `/agenda` Agenda · `/agenda/bloqueos` Bloqueos · `/agenda/configuracion` Configuración · `/medicos/micrositio` Mi micrositio · `/medicos/recepcion` Recepción |
| Recepción | `/recepcion/panel` Inicio · `/agenda` Agenda · `/agenda/bloqueos` Bloqueos |
| Paciente | `/pacientes/panel` Inicio · `/pacientes/citas` Mis citas · `/pacientes/consultorios` Mis consultorios |
| Soporte | `/soporte` Resumen · `/soporte/medicos` Médicos · `/soporte/micrositios` Micrositios · `/soporte/correos` Correos · `/soporte/metricas` Métricas · `/soporte/historial` Historial |

La página activa es la entrada con el prefijo de ruta más largo que coincide; si ninguna coincide (por ejemplo `/cuenta/...`), no hay activa. Con sesión a medias (segundo factor o avisos pendientes) no se muestra la navegación, solo logo, rol y «Salir». Limitación conocida: la sesión no trae el estado de aprobación del médico, así que un médico no aprobado o suspendido ve la navegación del médico completa.

## 5. Etiquetas de rol (tarjeta de usuario)

`doctor` → Médico · `reception` → Recepción · `patient` → Paciente · `support` → Soporte.
