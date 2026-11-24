# Research: Urgencias y triaje

Decisiones de la Fase 0. Cada una indica qué se eligió, por qué y qué se descartó. Las decisiones de producto de partida están
en `docs/decisions/0001-resumen-grill-me.md` (sección Urgencias) y en la spec; aquí solo se resuelve el «cómo».

## 1. La urgencia es una cita con `kind = 'urgent'`
- **Decision**: la urgencia es una fila de `appointment` con `kind = 'urgent'` (el valor se añade al `ENUM`; hoy solo existe
  `regular`). Nada más se guarda del triaje. Usa el mismo índice único de cita vigente y `withCalendarLock`.
- **Rationale**: hereda gratis la invariante de «sin doble reserva» y la cancelación; la etiqueta de la agenda sale de ese
  campo; cumple «solo se guarda el tipo de cita» (constitución I).
- **Alternatives**: una tabla `urgent_appointment` (duplica la agenda y la invariante); guardar la categoría en la cita
  (prohibido por la constitución).

## 2. Horarios de urgencia: `calendar_hours.kind`
- **Decision**: las franjas de urgencia son filas de `calendar_hours` con `kind ENUM('regular','urgent') DEFAULT 'regular'`.
  El médico guarda ambas listas juntas (se reemplazan todas al guardar, como hoy). Una franja de urgencia **no puede
  solaparse** con una convencional del mismo día (se rechaza al guardar con un mensaje claro); hasta 2 franjas de urgencia por
  día. Los espacios usan la duración y el intervalo del consultorio.
- **Rationale**: reutiliza la validación, el reemplazo atómico y la lectura de la feature 2; prohibir el solape resuelve «un
  mismo instante nunca es dos espacios» sin lógica de desduplicación entre dos mallas desalineadas.
- **Alternatives**: tabla `calendar_urgent_hours` (otra pantalla de lectura y otro reemplazo); permitir solape y desduplicar
  (inicios distintos generan espacios que se pisan: ambigüedad innecesaria).

## 3. Quién ve qué espacios
- **Decision**: `generateSlotsForDay` devuelve cada espacio con su `kind`. Calendario del paciente (`listFreeSlots`,
  disponibilidad del mes y del día, `resolveSlot` de la reserva convencional): solo `regular`. Triaje: `regular` y `urgent`.
  Agenda del personal: ambos, con etiqueta «Urgencia» en los espacios de urgencia; si el personal agenda en un espacio de
  urgencia, la cita queda `regular` (las urgencias nacen del triaje del paciente).
- **Rationale**: «los horarios de urgencia no aparecen en el calendario convencional»; el personal necesita verlos para no
  agendar encima por error y para ver las urgencias dentro del horario (si no, saldrían como «fuera del horario»).
- **Alternatives**: ocultar los espacios de urgencia al personal (las urgencias se verían como citas fuera del horario).

## 4. Búsqueda del espacio más próximo
- **Decision**: función pura `findNearestUrgentSlot({settings, hours, appointments, blocks, now, windowHours,
  minNoticeMinutes})`: recorre los días desde hoy hasta el día en que termina la ventana, clasifica con `classifySlots` y
  devuelve el primer espacio libre con `inicio >= now + minNoticeMinutes` e `inicio <= now + ventana` (bordes inclusivos). A
  igual inicio gana el de `urgent`. Una sola lectura de citas y una de bloqueos del rango (como el mes de la feature 3). Las
  anticipaciones de la reserva convencional (mínima y máxima) **no** se aplican a las urgencias; las de urgencia sí.
- **Rationale**: función pura = pruebas unitarias exhaustivas (zonas, cambio de hora, bordes) sin base de datos; el servicio
  solo la llama dentro del bloqueo del médico y revalida con `assertSlotBookable` antes de insertar.
- **Alternatives**: SQL que calcula el hueco (duplica las reglas de la feature 2 y es difícil de probar); asignar la hora
  exacta del momento de la solicitud (no respeta la malla de espacios).

## 5. Orden de las comprobaciones de `requestUrgent`
- **Decision**: fuera del servicio: validación zod, señales de alarma (bloquean sin tocar la base ni los contadores) y
  CAPTCHA (falla cerrado; no cuenta como solicitud). Dentro de `withCalendarLock`: (1) consultorio acepta reservas; (2)
  paciente de la cuenta; (3) doble envío (misma cuenta, mismo paciente, urgencia vigente creada hace menos de 2 minutos →
  devuelve esa cita); (4) una urgencia activa por paciente; (5) 3 solicitudes por cuenta en 24 h; (6) autorización de datos
  (casilla si no hay una activa); (7) búsqueda del espacio; (8) sin espacio → registra `urgent_requested` (rechazada) y
  confirma la transacción sin cita; con espacio → vínculo, autorización, inserción, registro y correos.
- **Rationale**: lo barato y lo que no debe consumir cupo va primero; un envío inválido no cuenta; «sin espacio» sí cuenta
  (FR-026) y por eso se confirma la transacción en lugar de lanzar una excepción.
- **Alternatives**: contar solo las urgencias agendadas (permite sondear la disponibilidad sin límite).

## 6. Contadores desde `calendar_action_log`
- **Decision**: acción nueva `urgent_requested` (`outcome`: `ok` agendada, `rejected` sin espacio) con `actor_user_id` del
  paciente. «3 por 24 h» = filas de esa acción de la cuenta en las últimas 24 h; «una activa» = cita `urgent` vigente del
  paciente que aún no empieza. No hay tabla de contadores; el registro conserva 90 días y no lleva categoría.
- **Rationale**: ya existe, es de solo anexar y se cuenta bajo el bloqueo del médico (como los límites de las features 2 y 3);
  cumple la constitución VI. El límite por cuenta es entre consultorios y, como los de la feature 2, puede excederse por una
  entre dos médicos distintos simultáneos (se acepta y se documenta).
- **Alternatives**: tabla de contadores con borrado a las 24 h (otra retención y otro cron); contador en memoria (se pierde
  al reiniciar y no escala).

## 7. La categoría viaja solo en el outbox
- **Decision**: el aviso al médico se encola como `doctor_urgent_notice` con `payload = { appointmentId, category }`
  (`category` ∈ lista fija de 5). Las plantillas declaran `sensitiveKeys` (aquí `["category"]`): `processOutbox` las elimina
  del `payload_ref` **en la misma transacción** que marca la fila como enviada, y también al marcarla cancelada o
  abandonada. Al abandonarse (agotados los reintentos) se encola `doctor_urgent_generic` («tienes una urgencia agendada,
  revisa tu agenda»). El job `urgent-notices` (primer paso de `jobs:outbox`) busca filas `doctor_urgent_notice` en cola con más
  de 24 h: las convierte en genéricas y borra la categoría; es idempotente. La categoría nunca se escribe en otro lugar:
  ni `appointment`, ni `calendar_action_log`, ni los logs (los eventos del outbox ya solo llevan id, plantilla e intentos).
- **Rationale**: es la única forma de cumplir «vive solo en la cola de envío y se borra al entregarse o a las 24 h» sin otra
  estructura; los tres estados finales (enviado, cancelado, abandonado) y el tiempo máximo cubren todos los caminos.
- **Alternatives**: no enviar la categoría (contradice la decisión de producto); cifrarla (sigue siendo dato guardado); borrar
  la categoría solo a las 24 h (la deja días en la tabla si el correo sale rápido).

## 8. CAPTCHA: Cloudflare Turnstile con `fetch`
- **Decision**: interfaz `CaptchaVerifier.verify(token, ip): Promise<"ok" | "invalid" | "unavailable">`. Implementación de
  producción: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` con `secret`, `response` (el campo del formulario
  `cf-turnstile-response`, máximo 2048 caracteres) y `remoteip`, con tiempo de espera de 5 s y sin reintentos; `success: true`
  es «ok»; respuesta con `success: false` es «invalid» (incluye `timeout-or-duplicate`: el token vence a los 5 minutos y es de un
  solo uso); un fallo de red, tiempo agotado o respuesta no válida es «unavailable». «Unavailable» **cierra** el flujo y
  muestra el móvil de emergencias y el teléfono del consultorio (FR-027). Variables `TURNSTILE_SITE_KEY` y
  `TURNSTILE_SECRET_KEY`: obligatorias en producción (sin ellas la urgencia no se ofrece); en desarrollo sin claves el paso se
  omite. La CSP se amplía solo en la ruta de urgencia con `script-src`/`frame-src https://challenges.cloudflare.com`. El
  proveedor solo recibe el token y la IP, nunca la categoría ni datos del paciente. Las pruebas inyectan un verificador falso.
- **Rationale**: gratis, sin dependencia npm, sin rastreo publicitario, con claves de prueba oficiales, y el modo «no
  disponible» queda explícito y probado. No se loguea el token ni la respuesta del proveedor.
- **Alternatives**: hCaptcha (equivalente, pide cuenta de pago para algunas funciones); reCAPTCHA (más datos a un tercero);
  reto propio sin tercero (no frena automatización); sin CAPTCHA (viola la constitución IV).

## 9. Contenido del triaje: módulo versionado con bandera de revisión
- **Decision**: `src/modules/urgent/triage-content.ts` exporta `version`, `reviewedByDentist` (por ahora `false`), las cinco
  categorías (`id`, nombre, color del semáforo, texto de la opción, `windowHours`, si exige el aviso de hospital), las dos
  señales de alarma, las indicaciones provisionales de primeros auxilios y el aviso de hospital. En `APP_ENV=production`, mientras
  `reviewedByDentist` sea `false`, el flujo de urgencia no se ofrece: se muestra «llama al consultorio» con el teléfono. El
  cambio a `true` (con la versión nueva) va por commit y revisión, y el aviso que muestra el flujo incluye la versión.
- **Rationale**: es contenido corto y estático, versionado por git y sin pantalla de edición; el bloqueo reproduce el
  comportamiento de los textos legales provisionales. Los valores de la tabla (2/12/24/48/72 h) son provisionales por decisión
  del responsable.
- **Alternatives**: guardarlo en `legal_document` (estructura de texto, no de datos; mezcla contenido médico con legal); tabla
  editable (otra pantalla de administración sin necesidad en el piloto).

## 10. Señales de alarma
- **Decision**: la pregunta («dificultad para tragar o respirar», «hinchazón cerca del ojo») va en el mismo formulario que la
  categoría. Si el `POST` trae cualquiera marcada, el servidor responde la pantalla de emergencia (aviso de hospital y móvil de
  emergencias del médico) **antes** de verificar el CAPTCHA, sin llamar al servicio, sin registrar nada, sin contar contra el
  límite y sin avisar al médico. El `POST` de urgencia también se valida en el servidor aunque el navegador omita la pregunta.
- **Rationale**: bloquear no debe depender del navegador ni consumir cupo, y no guardar nada respeta la constitución I.
- **Alternatives**: una pantalla previa separada (más pasos y estado entre pasos sin necesidad).

## 11. Móvil de emergencias «verificado»
- **Decision**: hasta que exista la verificación por WhatsApp (posterior al piloto), se muestra el `emergency_mobile` registrado
  de un médico aprobado (formato y unicidad ya validados en la feature 1). Si no tiene, el teléfono del consultorio. Solo se
  muestra al paciente con sesión en las pantallas de «sin espacio», «alarma» y «CAPTCHA no disponible»; el micrositio público no
  lo muestra.
- **Rationale**: la verificación depende de WhatsApp (fuera de alcance); mostrarlo solo a pacientes con sesión limita su difusión.
- **Alternatives**: no mostrar el móvil hasta verificarlo (anula la regla de seguridad de «sin espacio»).

## 12. Cancelación y límites de las citas convencionales
- **Decision**: `cancelAsPatient` omite el plazo de cancelación cuando la cita es `urgent` (se consulta `kind`); conserva el tope
  de 10 cancelaciones por hora por cuenta. Las urgencias **no** cuentan para las 5 reservas por hora ni para las 3 citas vigentes
  por paciente de la feature 3 (esas consultas filtran `kind = 'regular'`). Los recordatorios solo se encolan para citas
  `regular`. El aviso al médico de la cancelación reutiliza `doctor_appointment_cancelled` (sin categoría).
- **Rationale**: FR-023 y FR-029; cambios pequeños y localizados en consultas ya existentes.
- **Alternatives**: unos límites compartidos (una urgencia consumiría los cupos de reserva normal).

## 13. Límites por IP y rutas
- **Decision**: `GET /c/:slug/urgencia` 120 por minuto por IP; `POST /c/:slug/urgencia` 10 por hora por IP (además de 3 por 24 h
  por cuenta); el `POST` exige sesión de paciente, CSRF y que el consultorio acepte reservas; el rol del personal recibe 403. El
  resultado agendado redirige a `/pacientes/citas/:id`; sin espacio, alarma y CAPTCHA no disponible son pantallas con 200
  (informativas) y las demás respuestas siguen las del contrato.
- **Rationale**: reutiliza el mecanismo de límites de las features 1 a 3.

## Pruebas obligatorias (constitución V)

- Concurrencia: N solicitudes simultáneas contra un solo espacio libre (una agenda, las demás reciben el siguiente espacio o
  «sin espacio»); urgencia contra bloqueo; urgencia contra reserva convencional del mismo espacio; urgencia contra cancelación.
- Aislamiento: un paciente no alcanza urgencias de otra cuenta; el personal no pide urgencias; el médico sale del enlace.
- Límites: una activa por paciente, 3 por 24 h (contando «sin espacio»), CAPTCHA inválido y no disponible, límite por IP, doble
  envío; una solicitud inválida o bloqueada por alarma no cuenta.
- Privacidad: la categoría no aparece en ninguna tabla tras entregar, cancelar, abandonar o pasar 24 h; ni en logs, ni en el
  registro de acciones, ni en los correos al paciente; la señal de alarma no deja rastro.
- Entrega: el aviso al médico sale en el siguiente ciclo del cron; el aviso genérico sale si falla el envío o vence el plazo.
