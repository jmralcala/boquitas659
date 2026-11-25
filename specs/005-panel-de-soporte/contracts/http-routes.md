# Contrato: rutas HTTP del panel de soporte

Mismas convenciones que las features [1](../../001-cuentas-y-acceso/contracts/http-routes.md) a
[4](../../004-urgencias-y-triaje/contracts/http-routes.md): entrada validada con zod (400 con mensajes por campo), `POST` con
CSRF, `GET` nunca cambia estado (única excepción: `GET /soporte/medicos/:id/cedula` añade `view_cedula` al historial, porque una lectura sensible se audita por diseño), 303 tras `POST` con éxito, 429 con `Retry-After` por límite. Rol: **S** soporte con doble
factor verificado (`installSupportMfa` y `requireRole("support")`); cualquier otro rol o sesión recibe 403 (401 si no hay
sesión) sin revelar si el recurso existe. Todas las rutas HTML llevan `noindex` y `Cache-Control: no-store`. **Ninguna ruta
recibe ni devuelve datos de pacientes, contenido de correos ni la categoría de urgencia.** Límite de lectura: 120/min por IP;
de cambio: 30/hora, ambos por IP (hay una o dos personas de soporte).

Las acciones de cambio comparten entrada: `reason` (1 a 500 caracteres), `confirm` (`yes`) y, en cambios de estado, `from`
(estado visto por la persona). Sin motivo o sin confirmación: 400 y nada cambia. Estado distinto de `from` o transición no
válida: 409 `state_changed` sin cambios ni entrada en el historial. Éxito: 303 al detalle y una entrada en el historial.

## Inicio y médicos

| Método y ruta | Entrada (zod) | Resultado |
|---------------|---------------|-----------|
| `GET /soporte` | — | Inicio: pendientes de aprobar, cuentas suspendidas o en solo lectura, correos fallidos y accesos a cada sección |
| `GET /soporte/medicos` | `estado` (`pending` \| `approved` \| `rejected` \| `suspended` \| `read_only` \| `all`, por defecto `pending`), `q` (≤ 100) | Lista de hasta 200 médicos con nombre, estado de aprobación, estado operativo y fecha; búsqueda por nombre o correo |
| `GET /soporte/medicos/:id` | `id` entero positivo | Detalle (como hoy) más estado operativo, quién y cuándo lo cambió, estado del micrositio y **número** de citas futuras; botones según el estado. 404 si no existe |
| `GET /soporte/medicos/:id/cedula` | `id` | Archivo de la cédula (como hoy); **registra `view_cedula`** |
| `POST /soporte/medicos/:id/aprobar` · `POST /soporte/medicos/:id/rechazar` | `id`; `aprobar` exige `confirm = yes`; `rechazar` exige `reason` y `confirm = yes` | Sin la casilla (o sin motivo al rechazar): 400 y no cambia nada; además registran en el historial |
| `GET /soporte/medicos/:id/liberar-cedula` | `id` | Pantalla de confirmación con las citas futuras (número) y el estado del micrositio; no cambia nada |
| `POST /soporte/medicos/:id/liberar-cedula` | `id`, `reason`, `confirm` | Libera cédula y móvil, deja la cuenta `rejected`, el micrositio deja de aceptar reservas; 303 al detalle. Una cuenta **suspendida** responde 409: se reactiva antes (el usuario deshabilitado no podría reenviar la cédula) |
| `POST /soporte/medicos/:id/suspender` | `id`, `reason`, `confirm`, `from` (`active` \| `read_only`) | `active`/`read_only` → `suspended`: el usuario médico queda deshabilitado y sus sesiones se revocan; aviso al médico |
| `POST /soporte/medicos/:id/solo-lectura` | `id`, `reason`, `confirm`, `from` (`active`) | `active` → `read_only`; aviso al médico |
| `POST /soporte/medicos/:id/reactivar` | `id`, `reason`, `confirm`, `from` (`suspended` \| `read_only`) | → `active`; rehabilita al usuario si estaba suspendido; aviso al médico |

Solo se aceptan estas acciones sobre médicos **aprobados**; sobre pendientes o rechazados: 409. Las rutas no aceptan un id de
cuenta de soporte (FR-013): el id se resuelve contra `doctor`, nunca contra `user`.

## Micrositios

| Método y ruta | Entrada | Resultado |
|---------------|---------|-----------|
| `GET /soporte/micrositios` | `estado` (`draft` \| `published` \| `unpublished` \| `all`) | Conteos por estado y lista (médico, nombre del enlace, estado, última publicación) |
| `GET /soporte/micrositios/:doctorId/enlace` | `doctorId` | Formulario para cambiar el nombre con la advertencia «el enlace anterior dejará de funcionar y quedará reservado 90 días» |
| `POST /soporte/micrositios/:doctorId/enlace` | `doctorId`, `slug` (formato de `site-slug`), `reason`, `confirm` | Cambia el nombre en una transacción; 400 por formato, 409 `slug_taken` si está en uso o reservado por otro médico; registra `change_slug`; aviso al médico con el enlace nuevo |

## Cola de correos

| Método y ruta | Entrada | Resultado |
|---------------|---------|-----------|
| `GET /soporte/correos` | `pagina` | Conteos por estado (en cola, enviados, fallidos, cancelados), antigüedad del pendiente más viejo y fallidos paginados (50): id, tipo, destinatario enmascarado, fecha, intentos, código de motivo. **Sin cuerpo, asunto, `payload` ni categoría** |
| `POST /soporte/correos/:id/reintentar` | `id`, `reason`, `confirm` | Solo `failed` de un tipo sin claves sensibles: vuelve a `queued` con 0 intentos; 409 si no aplica (incluido el aviso de urgencia) |
| `POST /soporte/correos/:id/cancelar` | `id`, `reason`, `confirm` | `failed` o `queued` de un tipo sin claves sensibles → `cancelled`; 409 si no aplica |

## Métricas e historial

| Método y ruta | Entrada | Resultado |
|---------------|---------|-----------|
| `GET /soporte/metricas` | `periodo` (`semana` \| `4semanas` \| `piloto`, por defecto `4semanas`) | Finalización de reserva, tiempo para reservar (promedio y % menor a 2 min), correos entregados, urgencias agendadas frente a sin espacio, citas por médico por semana y médicos activos por semana, cada una con su meta y cumplimiento o «sin datos». Solo conteos y porcentajes; por médico solo conteos. Incluye una señal de posible abuso de urgencias (ahora): pacientes con más de una urgencia vigente y cuentas con más de 3 solicitudes en 24 h, solo cuántos. Sin categoría |
| `GET /soporte/historial` | `pagina`, `persona` (entero), `accion` (enum del historial), `objetivo` (id de un médico: incluye su ficha y su micrositio, no los correos), `desde`, `hasta` (`YYYY-MM-DD` reales, desde ≤ hasta) | Entradas de la más reciente a la más antigua: persona, acción, objetivo, motivo y fecha. **No existe ninguna ruta para modificar o borrar** |

Respuestas JSON (`Accept: application/json`): las mismas estructuras en campos camelCase, con el destinatario ya enmascarado y
sin `payload`.

## Cambios a rutas de otras features

| Ruta | Cambio |
|------|--------|
| Selector de consultorios de recepción y aceptación de invitaciones | Excluyen a los médicos suspendidos; las invitaciones de un médico suspendido o en solo lectura no se aceptan |
| Todas las rutas de médico y recepción (por el resolutor y `requireApprovedDoctor`) | Cuenta `suspended`: 403; cuenta `read_only`: 403 con «Tu cuenta está en solo lectura» en cualquier método distinto de `GET`/`HEAD` |
| `GET /c/:slug` · `GET/POST /c/:slug/reservar` · `GET/POST /c/:slug/urgencia` | Con la cuenta suspendida o en solo lectura: no se ofrecen reservas ni urgencias y se muestra «confirma por teléfono con el consultorio» |
| `GET /c/:slug/reservar` y `POST /c/:slug/reservar` | La entrada cuenta una vez; los enlaces del calendario llevan `a=<hora de entrada firmada>` y el formulario un campo oculto `abierto`; el `POST` la usa solo para los contadores del piloto |
| `POST /cuenta/movil-emergencia` | Respeta el estado: en solo lectura o suspendida responde 403. Las demás rutas de seguridad de la cuenta (contraseña, correo, doble factor) siguen abiertas en solo lectura por ser seguridad personal |
| `POST /agenda/citas/buscar` | En solo lectura también se rechaza (es una búsqueda hecha por POST; sin agendar no hace falta) |
| Rutas de paciente (`/pacientes/citas/...`, `/citas/enlace/...`) | Sin cambios: el paciente puede seguir cancelando en cualquier estado |
