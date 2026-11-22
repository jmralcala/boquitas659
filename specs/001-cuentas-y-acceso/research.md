# Research: Cuentas y acceso

Fase 0 de `/speckit-plan`. Cada decisión sigue el formato Decision / Rationale / Alternatives. Las versiones exactas de
paquetes y los detalles de API se verifican con Context7 al implementar (regla del proyecto); aquí solo se decide qué
usar y por qué.

## Hallazgos que afectan a la spec

- **Móvil vs. fijo en México**: desde agosto de 2019 los números móviles y fijos mexicanos tienen el mismo formato de
  10 dígitos (se eliminó el prefijo "1" de los móviles). Por número no se puede saber si es móvil. FR-004 pide
  garantizar que sea móvil; en esta versión solo se puede validar formato (10 dígitos mexicanos) y unicidad. La
  comprobación real de que sea móvil llega con la verificación por WhatsApp. **Se recomienda ajustar la redacción de
  FR-004** (la spec no se modificó desde este comando).
- **Supuestos abiertos de la decisión 0001 que siguen abiertos y afectan a esta feature**: retención de datos (no se
  implementa borrado), texto legal (se usa provisional con bloqueo en producción), copias de seguridad y monitoreo.

## Decisiones

### 1. Framework HTTP
- **Decision**: Fastify con plugins oficiales (`cookie`, `helmet`, `rate-limit`, `multipart`).
- **Rationale**: esquemas y validación de primera clase, pino integrado (con redacción de campos), menor consumo que
  alternativas con más capas; los plugins oficiales cubren cabeceras de seguridad, límite de tasa y subida de archivos.
- **Alternatives**: Express (más conocido, pero exige añadir más piezas y tiene más huella de memoria); NestJS
  (demasiada estructura y dependencias para el piloto); Next.js (no encaja con hosting Node simple y añade un SPA que
  no hace falta).

### 2. Interfaz: HTML en el servidor
- **Decision**: vistas como funciones TypeScript con una etiqueta de plantilla que escapa por defecto; formularios
  HTML estándar con mejora mínima de JavaScript (ninguna obligatoria).
- **Rationale**: pocas pantallas de formulario; reduce XSS (sin `innerHTML`), memoria y dependencias; funciona con
  enlaces de correo y botones POST.
- **Alternatives**: motor de plantillas (Eta, Nunjucks) — válido, pero es otra dependencia para pocas pantallas; SPA con
  React — más superficie y más trabajo sin beneficio en esta feature.

### 3. Base de datos y migraciones
- **Decision**: MariaDB con `mysql2` (consultas parametrizadas y pool) y migraciones en SQL numerado con un ejecutor
  propio mínimo (tabla `schema_migrations`).
- **Rationale**: es lo decidido en 0001; SQL explícito facilita los disparadores de solo anexar y los índices únicos;
  evita ORM y su costo de memoria.
- **Alternatives**: Kysely o Drizzle (tipado de consultas útil, pero otra capa; reevaluar si el modelo crece); Prisma
  (motor binario pesado para hosting compartido).

### 4. Hash de contraseñas
- **Decision**: argon2id mediante el paquete `argon2` detrás de una interfaz `PasswordHasher`, con respaldo bcrypt
  (`bcryptjs`, JavaScript puro) si el módulo nativo no corre en el hosting. Parámetros calibrados a ~250–500 ms.
- **Rationale**: cumple CLAUDE.md y la guía de seguridad; la interfaz permite cambiar sin tocar el resto. El riesgo es
  la binaria nativa en Hostinger: se prueba temprano (tarea de humo de despliegue).
- **Alternatives**: `scrypt` de Node (sin dependencias, pero no está en la lista aprobada por la guía de seguridad);
  solo bcrypt (límite de 72 bytes en la contraseña).

### 5. Contraseñas comunes o filtradas
- **Decision**: lista local de contraseñas comunes (archivo incluido en el repositorio, carga única en memoria como
  conjunto o filtro) más reglas: ≥ 10 caracteres, sin reglas de composición, y rechazo si coincide con el correo o
  el nombre. Consulta de contraseñas filtradas por k-anonimato (rango de hash) queda como mejora opcional.
- **Rationale**: no depende de un servicio externo ni lo expone a fallas o fuga de metadatos; suficiente para el
  piloto.
- **Alternatives**: llamar a un servicio externo en cada registro (dependencia de red, SSRF, privacidad); no rechazar
  filtradas (incumple FR-031). **Pendiente**: elegir la lista de origen (p. ej. las más frecuentes de una lista pública
  reconocida) y su licencia al implementar.

### 6. Sesiones
- **Decision**: sesión opaca de servidor: token aleatorio de 32 bytes (`crypto.randomBytes`), se guarda solo su hash
  SHA-256 en la tabla `session`; cookie `HttpOnly`, `Secure`, `SameSite=Lax`, prefijo `__Host-`. Caducidad por
  inactividad (30 min personal, 60 min paciente) y tope absoluto (12 h). Se regenera el token al iniciar sesión y al
  subir de privilegio (segundo factor). La sesión de recepción guarda el médico activo y se revalida contra los
  vínculos en cada petición.
- **Rationale**: revocación inmediata (basta borrar la fila), sin JWT que verificar ni caducar; un token de alta
  entropía puede hashearse con SHA-256 sin riesgo de fuerza bruta.
- **Alternatives**: JWT sin estado (no permite cortar el acceso de recepción al instante); `express-session` (no aplica).

### 7. CSRF
- **Decision**: token sincronizador ligado a la sesión, incluido en cada formulario y verificado en toda ruta que
  cambia estado (POST/PUT/DELETE); además `SameSite=Lax`. Para páginas sin sesión (login, registro, recuperación) se
  usa un token firmado de doble envío.
- **Rationale**: simple, sin dependencia, cumple FR-039 y el patrón "GET muestra, POST ejecuta" de los enlaces de correo.
- **Alternatives**: `@fastify/csrf-protection` (válido; se prefiere implementación propia mínima si no ahorra código).

### 8. Tokens de un solo uso (recuperación, invitación, enlaces de correo)
- **Decision**: 32 bytes aleatorios codificados en base64url; en la base solo el hash SHA-256, el propósito, el
  sujeto, `expires_at` y `used_at`. Abrir el enlace (GET) muestra el resumen sin consumir; el POST con CSRF consume el
  token en una actualización condicional (`WHERE used_at IS NULL AND expires_at > NOW()`), de modo que dos
  peticiones simultáneas no pueden usarlo dos veces. Caducidad: recuperación 30 min, invitación 7 días.
- **Rationale**: antivirus y clientes de correo abren enlaces automáticamente; evita consumir el token por accidente;
  la búsqueda por hash no necesita comparación de tiempo constante porque el token tiene alta entropía y no se compara
  con un secreto conocido.
- **Alternatives**: tokens firmados sin estado (no se pueden marcar como usados).

### 9. Límite de intentos y de peticiones
- **Decision**: dos capas. (a) Límite por IP en memoria con `@fastify/rate-limit` en rutas públicas (registro,
  recuperación, correo existente). (b) Control de intentos de inicio de sesión en base de datos (`login_throttle` por
  cuenta e IP) con espera exponencial (p. ej. 1, 2, 4, … hasta un máximo), porque en hosting compartido puede haber
  varias instancias y el estado en memoria no se comparte. Respuestas idénticas para correo inexistente y contraseña
  incorrecta; se ejecuta un hash ficticio para igualar tiempos.
- **Rationale**: cumple FR-016 y FR-033 sin infraestructura extra.
- **Alternatives**: Redis (otra pieza que operar); bloqueo permanente de cuenta (permite denegar servicio a un usuario).

### 10. Doble factor (TOTP)
- **Decision**: TOTP con `otplib`; el secreto se cifra en reposo con AES-256-GCM usando una clave de entorno
  (`MFA_ENCRYPTION_KEY`); 10 códigos de recuperación de un solo uso guardados como hash. Obligatorio para soporte
  (no accede a nada hasta configurarlo), opcional para médicos y recepción.
- **Rationale**: estándar, sin costo por mensaje, funciona sin WhatsApp ni SMS.
- **Alternatives**: SMS/WhatsApp (costo, fuera de alcance, ataques de SIM); WebAuthn (mejor, pero más complejo; posible
  mejora futura).

### 11. Dispositivo nuevo
- **Decision**: cookie de dispositivo de larga vida con un identificador aleatorio; se guarda su hash por usuario.
  Si un inicio de sesión llega sin cookie conocida, se envía el aviso por correo y se registra el dispositivo.
- **Rationale**: cumple FR-037 sin guardar huellas ni direcciones IP completas.
- **Alternatives**: huella del navegador o IP (invasivo y frágil).

### 12. Correo
- **Decision**: tabla `email_outbox` (destinatario, plantilla, datos mínimos, estado, intentos, `next_attempt_at`);
  un script de cron cada minuto la procesa con reintentos y envía con `nodemailer` por el SMTP de Hostinger. El
  contenido sensible se genera al enviar a partir del identificador de la fila, y el cuerpo enviado no se
  guarda. Para plantillas con enlace (`password_reset`, `reception_invitation`) el procesador crea el token de
  un solo uso en el momento de enviar, en la misma transacción que marca el correo como enviado; el token nunca
  se guarda en claro y su caducidad (30 minutos o 7 días) cuenta desde el envío. Si se reintenta el envío, el
  token anterior se invalida y se crea uno nuevo. Las filas entregadas se limpian después de unos días.
- **Rationale**: encaja con el cron por minuto de 0001 y la constitución (VI), tolera caídas del SMTP, evita enviar
  dentro de la petición HTTP.
- **Alternatives**: envío síncrono (bloquea y pierde correos si falla); proveedor transaccional (queda como respaldo,
  según 0001).

### 13. Subida de la cédula
- **Decision**: `@fastify/multipart` con límite de 5 MB; solo JPEG, PNG o PDF verificados por firma de bytes (no por
  extensión ni `Content-Type`); nombre en disco aleatorio; directorio privado fuera de la raíz pública; solo se
  sirve a soporte autenticado mediante una ruta que comprueba permiso. Sin adjuntos en correos. Se guarda el hash del
  archivo y el número de cédula normalizado.
- **Rationale**: previene ejecución de archivos subidos, traversal de rutas y filtración por enlaces públicos.
- **Alternatives**: almacenamiento externo (S3, etc.; otro tercero y otro aviso de privacidad).

### 14. Aislamiento por médico en el código
- **Decision**: toda función de repositorio que lee o escribe datos de pacientes o citas recibe un `TenantContext`
  (`{ doctorId, actor }`) como primer argumento obligatorio; no existen funciones de lectura de pacientes sin él. La
  recepción construye el contexto con el médico activo y solo tras comprobar el vínculo vigente. Pruebas de integración
  con dos médicos y un paciente compartido verifican que no hay fuga.
- **Rationale**: convierte la regla de la constitución (II) en una restricción de tipos y de pruebas, no solo de
  disciplina.
- **Alternatives**: filtros manuales en cada consulta (propensos a olvido); vistas de base por tenant (no portables).

### 15. Registro de solo anexar
- **Decision**: disparadores `BEFORE UPDATE` y `BEFORE DELETE` con `SIGNAL` en `consent_acceptance` y
  `patient_access_log`; el usuario de la aplicación no recibe privilegios de borrado sobre esas tablas cuando el
  hosting lo permita.
- **Rationale**: FR-020 pide un registro de solo lectura para usuarios; la base lo garantiza aun con un bug en la app.
- **Alternatives**: solo convención en el código (no verificable).

### 16. Registro técnico (logs)
- **Decision**: pino con redacción de rutas sensibles (`req.headers.authorization`, `req.headers.cookie`,
  cuerpos de petición no se registran) y un identificador de petición; los errores se registran con código y contexto
  (identificador de usuario, no correo ni nombre).
- **Rationale**: constitución I y IV, FR-042.

### 17. Alta de soporte y vista mínima
- **Decision**: la cuenta de soporte se crea con un script de línea de comandos (`create-support-user`) que pide la
  contraseña por entrada estándar y obliga a configurar TOTP en el primer acceso. La vista mínima de soporte cubre:
  lista de pendientes, ver cédula, aprobar, rechazar con motivo y liberar cédula/móvil.
- **Rationale**: no existe registro público de soporte; evita una ruta de alta que sea objetivo de ataque.

### 18. Entorno de pruebas
- **Decision**: pruebas de integración contra una MariaDB real (local) indicada por `TEST_DATABASE_URL`, con base
  recreada por ejecución; sin simular la base porque las garantías (índices únicos, disparadores, transacciones) son
  parte de lo que se prueba.
- **Alternatives**: SQLite en memoria (comportamiento distinto en bloqueos y disparadores).

## Dependencias nuevas

Regla del proyecto: no instalar dependencias nuevas sin explicar por qué. Nada se instala en `/speckit-plan`.

| Paquete | Para qué | Por qué no basta con Node estándar |
|---------|----------|------------------------------------|
| `fastify` | Servidor HTTP | Node `http` no trae validación, enrutado ni gancho de ciclo de vida |
| `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart` | Cookies, cabeceras, límites, archivos | Reescribirlo es más riesgoso que usar plugins oficiales mantenidos |
| `zod` | Validación en runtime | Exigido por CLAUDE.md |
| `mysql2` | Cliente de MariaDB | Sin controlador no hay base; soporta consultas parametrizadas |
| `argon2` (+ `bcryptjs` como respaldo) | Hash de contraseñas | Exigido por la guía de seguridad; `crypto` no trae argon2id/bcrypt |
| `otplib` | TOTP | Implementar TOTP a mano es innecesario riesgo |
| `nodemailer` | Envío SMTP | Node no incluye cliente SMTP |

Antes de instalar: revisar mantenimiento, versión reciente y que el nombre no sea una suplantación de otro popular.

## Riesgos abiertos

1. `argon2` nativo en Hostinger: probar en el despliegue de humo; si falla, usar `bcryptjs` (interfaz ya aislada).
2. Límites de envío del SMTP de Hostinger y entregabilidad (SPF, DKIM, DMARC) para los correos de seguridad.
3. Latencia de hasta ~1 min por cron en correos de recuperación (aceptable con enlace de 30 min).
4. Texto legal provisional: el bloqueo en producción depende de marcar el documento como revisado.
5. Sin plan de copias de seguridad ni de qué pasa si falla el cron (supuesto abierto 8 de 0001).
