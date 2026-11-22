# boquitas659 Constitution

## Core Principles

### I. Privacidad y datos de salud primero (NON-NEGOTIABLE)
La plataforma trata datos personales y datos sensibles de salud (LFPDPPP). Por tanto:
- Ningún paciente real entra al sistema sin que los textos legales (aviso de privacidad, términos y
  cláusula de encargo de tratamiento) hayan sido revisados por un abogado; el texto provisional solo
  se admite en desarrollo y pruebas.
- Toda aceptación (paciente, tutor, médico, recepción, WhatsApp) MUST usar una casilla sin marcar de
  antemano que bloquee el avance, y MUST registrarse con quién, qué documento, qué versión y cuándo.
  Un cambio de texto MUST exigir nueva aceptación.
- No se guarda historial clínico ni el resultado del triaje; solo el tipo de cita (urgencia o
  convencional). La categoría de urgencia vive únicamente en la cola de envío y se borra al entregarse
  o a las 24 h como máximo.
- Los registros técnicos, métricas y herramientas de errores MUST NOT contener datos personales,
  categoría de urgencia ni contenido de mensajes.
- Cada acceso al detalle de un paciente MUST quedar registrado (quién y cuándo, sin contenido).

Razón: un filtrado de datos de salud causa daño real al paciente y responsabilidad legal al médico.

### II. Aislamiento por médico
La cuenta del paciente es global, pero los datos se guardan por relación médico-paciente. Toda
consulta de datos de pacientes, citas o agenda MUST filtrar por el médico (tenant) en el servidor y
MUST comprobar propiedad o permiso, no solo sesión. Una consulta sin ese filtro es un defecto
bloqueante. Recepción actúa solo sobre los médicos que la invitaron, y cada acción registra quién la
hizo. Se MUST probar de forma automática que un médico no accede a pacientes de otro.

### III. Integridad de la agenda
"Sin doble reserva" es una invariante, no una intención. Reservar MUST ocurrir en una transacción que
bloquea la fila del médico, revisa el solape e inserta, con un índice único (médico, hora de inicio)
como respaldo. Debe existir una prueba automática de reservas simultáneas. Las horas se guardan en UTC
y se muestran en la zona horaria del consultorio. Cancelar libera el espacio. Abrir un enlace de
correo MUST NOT cambiar el estado de una cita: el cambio ocurre al pulsar un botón, con token firmado,
de un solo uso, con caducidad y protección CSRF.

### IV. Seguridad y validación en runtime por defecto
- Toda entrada externa (body, query, params, headers, webhooks, archivos) MUST validarse con zod u otro
  esquema antes de usarse; los tipos solos no bastan.
- SQL siempre parametrizado; sin concatenar entrada en SQL, shell, rutas ni URLs.
- Contraseñas con argon2id o bcrypt, mínimo 10 caracteres, rechazo de comunes o filtradas; límite de
  intentos con espera creciente; cookies `HttpOnly`, `Secure` y `SameSite`.
- Endpoints públicos y de autenticación MUST tener límite de tasa; la urgencia, además, CAPTCHA.
- Ningún secreto en código, tests ni logs; se leen de variables de entorno.
- Los errores nunca se tragan: se registran con contexto sin datos sensibles y el cliente recibe
  mensajes sin detalles internos.
- Sin `any` salvo justificación en comentario.
El detalle vigente está en `.claude/claude-security-guidance.md`.

### V. Test-First para el comportamiento nuevo
Todo comportamiento nuevo MUST tener pruebas (vitest) escritas antes o junto con la implementación, y
estas MUST fallar antes de implementar cuando se trate de reglas de negocio. Son obligatorias las
pruebas de: concurrencia de reservas, aislamiento entre médicos, límites de cancelación y de urgencia,
caducidad y uso único de tokens, y registro de consentimientos. Una tarea no está terminada si
compila pero no tiene pruebas del comportamiento.

### VI. Simplicidad y operación realista
La primera versión corre en hosting compartido (Node.js, MariaDB, cron por minuto). Se prefiere la
solución más simple que cumpla la spec (YAGNI): sin procesos permanentes, colas externas ni
dependencias nuevas sin justificar por escrito. Las tareas programadas MUST ser idempotentes y tolerar
reintentos. Los avisos de urgencia MUST NOT bloquearse por cuota; su entrega a tiempo MUST verificarse
antes del piloto.

## Restricciones técnicas y de producto

- Stack: Node.js (LTS) + TypeScript, npm, vitest, ESLint, Prettier, MariaDB (InnoDB), zod.
- Despliegue en Hostinger Business Web Hosting (`agendadental.innvend.com`); correo por SMTP con el
  médico como `Reply-To`, y SPF, DKIM y DMARC configurados.
- Alcance de la primera versión (piloto de 3 a 5 médicos): sin WhatsApp ni cobro automático con
  Openpay; las cuentas se activan manualmente. Fuera de alcance: reprogramación, historial clínico,
  duraciones por tipo de tratamiento y registro abierto de médicos.
- El micrositio (`/c/nombre`) usa `noindex`, no tiene directorio y solo existe con calendario
  publicado. El médico no accede hasta que soporte aprueba manualmente su cédula.
- El contenido médico del triaje (primeros auxilios, aviso de acudir a un hospital) MUST ser validado
  por un dentista antes de mostrarse a pacientes reales.
- Las decisiones de producto viven en `docs/decisions/`; contradecirlas exige una nueva decisión.

## Flujo de desarrollo y puertas de calidad

1. Idea nueva: `grill-me`. Feature: `/speckit-specify`, `/speckit-plan`, `/speckit-tasks`,
   `/speckit-implement`.
2. Definición de terminado: compila; pasan `npm run lint`, `typecheck` y `test`; hay pruebas del
   comportamiento nuevo; sin secretos ni `console.log` de depuración; la spec refleja lo implementado.
3. Antes del PR: `code-review` y `/security-review`. Todo PR MUST verificar el cumplimiento de esta
   constitución, en especial los principios I a III.
4. No se editan `.env*`, lockfiles ni `secrets/`. No se instalan dependencias nuevas sin explicar por
   qué. No se ejecutan comandos destructivos ni scripts remotos descargados.
5. Commits pequeños con mensajes en imperativo. Para documentación de librerías se usa Context7.

## Governance

Esta constitución prevalece sobre otras prácticas y guías del proyecto. Una enmienda requiere: un
cambio documentado en este archivo con su razón, la actualización de la spec, plan o tareas afectados,
y la aprobación explícita del responsable del proyecto. Las desviaciones puntuales MUST justificarse
por escrito en el plan de la feature (sección de complejidad) y no se vuelven norma sin enmienda.

Versionado semántico: MAJOR por eliminar o redefinir un principio de forma incompatible; MINOR por
añadir un principio o sección, o ampliar materialmente la guía; PATCH por aclaraciones y redacción.

Revisión de cumplimiento: cada spec y plan comprueba esta constitución antes de avanzar, y cada PR la
revisa. Orientación operativa: `CLAUDE.md` y `.claude/claude-security-guidance.md`.

**Version**: 1.0.0 | **Ratified**: 2026-11-21 | **Last Amended**: 2026-11-21
