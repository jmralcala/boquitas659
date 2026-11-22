# 0002 · Cuentas y acceso: decisiones técnicas de la primera feature

Estado: implementada. Fecha: 2026-11-21.
Origen: `specs/001-cuentas-y-acceso/` (spec, plan, research, data-model, contracts y tasks). Complementa
`0001-resumen-grill-me.md` (decisiones de producto).

## Decisiones

### Arquitectura
- Una sola aplicación Node.js + TypeScript con Fastify y vistas HTML en el servidor (sin SPA); MariaDB con SQL
  parametrizado y `mysql2`; migraciones SQL numeradas con un ejecutor propio (`npm run migrate`).
- Raíz de composición en `src/compose.ts`; cada módulo (`auth`, `doctors`, `patients`, `reception`, `legal`,
  `support`, `audit`) expone servicios y rutas. Las rutas, los roles y las respuestas están en
  `specs/001-cuentas-y-acceso/contracts/http-routes.md` y una prueba (`route-audit`) comprueba que lo registrado
  coincide con el contrato.

### Sesiones y tokens
- Sesiones opacas en la base de datos: solo se guarda el hash SHA-256 del token. Cookie `__Host-` con `HttpOnly`,
  `Secure` y `SameSite=Lax`. Caducidad por inactividad (30 min personal, 60 min pacientes) y tope de 12 h. Se
  puede cortar una sesión al instante (retiro de recepción, cambio de contraseña).
- Tokens de un solo uso (recuperación, invitación, confirmación de correo): 32 bytes aleatorios, solo su hash en la
  base, caducidad propia y consumo atómico dentro de la transacción. **El token nace al enviar el correo**, no al
  encolarlo, así que el outbox nunca guarda un token en claro. Abrir un enlace nunca lo consume.
- CSRF: token sincronizador ligado a la sesión; sin sesión, doble envío firmado con HMAC. Una prueba verifica que
  TODA ruta que cambia estado responde 403 sin token.

### Contraseñas y doble factor
- argon2id con respaldo bcrypt (con pre-hash SHA-256 para no truncar a 72 bytes) detrás de `PasswordHasher`; se
  re-hashea al iniciar sesión si el algoritmo o los parámetros son más débiles. Política: mínimo 10 caracteres, sin
  reglas de composición, rechazo de comunes y de las iguales al correo o nombre.
- Control de intentos con espera creciente por cuenta e IP, guardado en la base (hosting con varias instancias) y
  solo con HMAC de correo e IP. `TRUST_PROXY` nunca acepta `true` (saltos o lista de IP/CIDR), para que la IP no se
  pueda falsificar.
- TOTP con `otplib` 13: secreto cifrado en reposo con AES-256-GCM, tolerancia de ±30 s, sin reutilización de códigos
  (último paso aceptado) y 10 códigos de recuperación guardados como HMAC. Obligatorio para soporte: sin él solo se
  llega a la pantalla de alta.
- Cambios sensibles piden la contraseña actual. El cambio de correo se verifica: el correo nuevo queda pendiente y
  solo se aplica al abrir el enlace enviado a esa dirección (respuesta a una revisión de seguridad).

### Aislamiento por médico y auditoría
- `TenantContext` con marca de tipo: no se puede fabricar con un objeto literal. La única vía desde una sesión es
  `TenantResolver`, que revalida en cada petición que la recepción siga vinculada con un médico aprobado. Las
  funciones del repositorio de pacientes para un médico reciben el contexto como primer parámetro.
- `consent_acceptance` y `patient_access_log` son de solo anexar mediante disparadores en la base; el código nunca
  actualiza ni borra esas tablas (hay una prueba que lo verifica). El registro de accesos no guarda contenido y
  también anota los intentos denegados.

### Textos legales
- Documentos versionados con marca de provisional. Con `APP_ENV=production` un documento provisional bloquea el
  alta de pacientes, el registro de médicos y la aceptación de invitaciones de recepción. Una versión nueva obliga
  a aceptarla (filtro global). `npm run legal:publish` publica la versión revisada.

### Correo
- Tabla `email_outbox` procesada por cron cada minuto, con reintentos con espera creciente, idempotente y segura si
  el cron se solapa. Transporte SMTP con STARTTLS obligatorio y TLS 1.2 como mínimo. El informe `report:email`
  calcula el porcentaje entregado para la meta de SC-010.

### Corrección de la spec
- FR-004: en México los móviles y los fijos tienen el mismo formato de 10 dígitos desde 2019, así que solo se valida
  formato y unicidad del móvil de emergencias; que sea móvil se confirmará con la verificación por WhatsApp.

## Riesgos y pendientes
1. **Textos legales**: los cinco documentos siguen siendo provisionales; hasta que un abogado los revise y se
   publiquen con `--reviewed` no puede entrar ningún paciente, médico ni recepción reales en producción.
2. **MariaDB y hosting**: las pruebas de integración se ejecutaron contra MySQL 8.0 (con `log_bin_trust_function_creators`
   activo). Hay que repetirlas contra MariaDB y comprobar `CREATE TRIGGER` con el usuario real de Hostinger: si no
   permite disparadores, el plan B es forzar el solo anexar desde la aplicación y con permisos de base de datos.
3. **Módulo nativo `argon2`** en el hosting (respaldo bcrypt ya disponible), latencia real del cron de un minuto,
   SPF/DKIM/DMARC y límites del SMTP: pendientes del humo de despliegue (ver `docs/configuration.md`).
4. **Lista de contraseñas comunes** compilada a mano (~190 entradas): sustituir por una lista pública con licencia
   verificada antes del piloto.
5. **Doble factor**: la pantalla de alta muestra clave y enlace `otpauth://`, sin código QR; los pacientes no lo usan.
6. **Sin definir todavía** (supuestos abiertos de 0001): retención y borrado de datos, copias de seguridad,
   monitoreo y qué ocurre si falla el cron.
7. **No probado**: envío por un SMTP real, ni los scripts de línea de comandos con una terminal interactiva (sí sus
   servicios).

## Revisiones de código y de seguridad (T126)

Dos revisiones independientes (calidad de código y seguridad) leyeron todo el diff de la feature: **0 hallazgos
críticos o altos** y ningún bloqueante. Se corrigió lo siguiente, cada punto con su prueba:

- **Outbox:** timeouts del SMTP menores que la reserva de 2 min; los errores se registran (id, plantilla, intento,
  tipo y código del error, nunca mensajes ni destinatarios); la entrega es *al menos una vez* y está documentado; un
  correo que ya no tiene sentido se cancela (`cancelled`) en lugar de enviarse (invitación revocada o vencida, otro
  cambio de correo pedido) y no cuenta como fallo de entrega.
- **Informe de entrega (SC-010):** los correos entregados se conservan 30 días, igual que los fallidos; antes se
  borraban a los 7 y el porcentaje salía sesgado a la baja.
- **Doble factor:** el contador de intentos ya no se reinicia al repetir la contraseña (la espera sigue creciendo);
  usar un código de recuperación deja evento y avisa por correo; el alta es atómica; el evento y el aviso van en la
  misma transacción que el cambio.
- **Cambio de correo:** el enlace queda ligado a su dirección de destino y pedir otro cambio invalida el anterior;
  máximo 5 solicitudes por hora y usuario.
- **Sesiones:** al cambiar contraseña o correo, o recuperar la contraseña, el cierre de sesiones ocurre dentro de la
  misma transacción; tras recuperar la contraseña se limpia la espera por intentos de esa cuenta.
- **Abuso de correo:** a una misma dirección solo se le encolan 3 correos de recuperación por hora.
- **Configuración y cabeceras:** `TRUST_PROXY` es obligatoria en producción (0 si no hay proxy); multipart solo se
  admite en las dos rutas de la cédula; las páginas HTML llevan `Cache-Control: no-store`; límite de peticiones en el
  detalle de pacientes.
- **Menores:** cédula normalizada al reenviar la solicitud, borrar un archivo ya no oculta el error original, tope de
  500 filas en el listado de pacientes de un médico, y espera por intentos que nunca se acorta con fallos simultáneos.

### Decisiones de producto pendientes (no son errores de código)
1. **Bloqueo de cuenta por terceros.** La espera por intentos es por cuenta y por IP; quien conozca un correo puede
   mantenerlo en espera de hasta 15 min con un intento fallido cada tanto. Opciones: no aplicar la espera de cuenta a
   los dispositivos ya conocidos (`__Host-did`), o añadir un desafío por correo.
2. **Registro sin verificar el correo.** Un paciente o médico puede registrarse con el correo de otra persona (queda
   sin poder crear su cuenta). La decisión 0001 acepta revelar que un correo existe, pero no cubre esto: haría falta
   verificar el correo antes de activar la cuenta.
3. **Invitaciones de recepción.** Un médico aprobado puede sondear qué correos tienen cuenta de otro rol (mensaje
   genérico, pero distinto de «invitación enviada»). Alternativa: responder siempre «invitación enviada» y resolver al
   aceptar.

### Endurecimiento pendiente (bajo)
- Derivar subclaves distintas (HKDF) para el cifrado de secretos TOTP, el HMAC de códigos de recuperación y el CSRF, y
  documentar la rotación de claves (el prefijo `v1:` ya lo permite).
- Exigir TLS en la conexión a la base de datos si el hosting la separa del servidor de la aplicación.
- Limitar sesiones simultáneas por usuario y escribir `last_seen_at` como máximo una vez por minuto.
- Desactivar el doble factor y cambiar el móvil de emergencias piden solo la contraseña (no un código TOTP).
- Almacén compartido para el límite de peticiones por IP si la aplicación corre en varias instancias.
- Paginar el panel de recepción más allá de las 500 filas actuales.

### Nota posterior: carrera entre la comprobación y el envío
Una revisión automática señaló que `shouldSend` se evaluaba fuera de la transacción que crea el token: si entre la
comprobación y la creación se pedía otro cambio de correo, el enlace del primero quedaba vigente. Ahora la
comprobación se repite DENTRO de la transacción de envío con `SELECT … FOR UPDATE` sobre la fila de la que depende
(el usuario, o la invitación), de modo que ambas peticiones se serializan. Hay una prueba que intercala el cambio
justo después de la comprobación; se verificó que falla con el código anterior.
