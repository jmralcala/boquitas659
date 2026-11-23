# Configuración (variables de entorno)

Todas se leen una sola vez al arrancar (`src/config/env.ts`) y se validan con zod. Los valores de ejemplo son
ficticios. **Nunca** se commitean valores reales; para desarrollo se usa un `.env` local (ignorado por git).

> `.env.example` debe actualizarse a mano con los nombres de esta lista (esta herramienta no puede leerlo por política
> de permisos del proyecto).

| Variable | Obligatoria | Propósito | Ejemplo |
|----------|-------------|-----------|---------|
| `APP_ENV` | sí | `development` o `production`. En `production` los avisos legales provisionales bloquean altas | `development` |
| `PUBLIC_BASE_URL` | sí | URL base para construir enlaces de correo | `http://localhost:3000` |
| `TRUST_PROXY` | no en desarrollo (`false`); **obligatoria en producción** (usa `0` si no hay proxy) | Confianza en el proxy inverso del hosting para leer la IP real del cliente en los límites de peticiones. `false` (o `0`): no se confía en `X-Forwarded-For`. Un entero de 1 a 10: número de saltos del proxy propio. O una lista de IP/CIDR separada por comas. **Nunca `true`**: permitiría falsificar la IP y evadir el límite | `1` |
| `PORT` | no (3000) | Puerto HTTP | `3000` |
| `DATABASE_URL` | sí | Conexión a MariaDB | `mysql://app:cambia-esto@localhost:3306/boquitas` |
| `TEST_DATABASE_URL` | solo pruebas | Base de pruebas (se recrea en cada ejecución); sin ella se omiten las pruebas de integración | `mysql://root:cambia-esto@localhost:3306/boquitas_test` |
| `SESSION_SECRET` | sí | Secreto de al menos 32 caracteres para firmar tokens CSRF previos a la sesión | (generar con `openssl rand -hex 32`) |
| `MFA_ENCRYPTION_KEY` | sí | Clave de 32 bytes en hexadecimal (64 caracteres) para cifrar secretos TOTP en reposo | (generar con `openssl rand -hex 32`) |
| `PASSWORD_HASHER` | no (`argon2`) | `argon2` o `bcrypt` (respaldo si el módulo nativo no corre en el hosting) | `argon2` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | sí en producción | Transporte de correo | `smtp.example.com` |
| `SUPPORT_EMAIL` | no (`soporte@innvend.com`) | Destino del aviso de nuevas solicitudes de médicos | `soporte@innvend.com` |
| `CEDULA_STORAGE_DIR` | sí | Directorio privado, **fuera de la raíz pública**, para los archivos de cédula | `./storage/cedulas` |
| `RIGHTS_CONTACT_EMAIL` | no (`soporte@innvend.com`) | Canal para derechos ARCO (provisional hasta revisión legal) | `soporte@innvend.com` |
| `RIGHTS_RESPONSE_DAYS` | no (`20`) | Plazo de respuesta a derechos ARCO en días hábiles (provisional hasta revisión legal) | `20` |

## Notas

- Cookies: `__Host-` exige `Secure`; en desarrollo sobre `http://localhost` los navegadores modernos lo aceptan.
- La lista de contraseñas comunes está en `src/modules/auth/data/common-passwords.txt` (ver su encabezado para fuente y
  licencia).

## Textos legales: de provisionales a revisados

Los 5 documentos (aviso de pacientes, aviso de médicos, aviso de recepción, compromiso de confidencialidad de
recepción y términos para médicos) se siembran al arrancar como **provisionales**. Con `APP_ENV=production` mientras
la última versión de un documento siga provisional **no se admiten** altas de pacientes, registros de médicos ni
aceptación de invitaciones de recepción (403).

Cuando el abogado entregue el texto revisado de cada documento:

1. Guarda el texto en un archivo UTF-8 (párrafos separados por una línea en blanco).
2. Publícalo marcándolo como revisado (compila antes con `npm run build`):

   ```text
   npm run legal:publish -- --type patient_privacy --file aviso-pacientes.txt --reviewed
   ```

   Tipos válidos: `patient_privacy`, `doctor_privacy`, `reception_privacy`, `reception_confidentiality`, `terms_doctor`.
   Opcional: `--title "Título del documento"`. Sin `--reviewed` queda provisional.
3. Cada publicación crea una versión nueva (las anteriores se conservan). Quien ya tenía cuenta deberá aceptar la
   nueva versión la próxima vez que entre (pantalla `/legal/aceptar`).
4. Repite para los 5 documentos. Antes del piloto, comprueba en `/legal` que ninguno diga "provisional".

## Humo de despliegue en Hostinger (antes del piloto)

Todo esto queda **pendiente hasta desplegar**; ninguno de estos puntos se ha podido comprobar en desarrollo.

| # | Comprobación | Cómo | Resultado |
|---|--------------|------|-----------|
| 1 | Carga del módulo nativo `argon2` | `npm run build` y arrancar la app con `PASSWORD_HASHER=argon2`; crear un usuario con `npm run support:create` e iniciar sesión. Si falla la carga, usar `PASSWORD_HASHER=bcrypt` (ya soportado) | pendiente |
| 2 | Disparadores de solo anexar | Con el usuario real de la base de datos, ejecutar `npm run migrate`. Si `CREATE TRIGGER` falla (log binario sin `SUPER`), aplicar el plan B de `research.md` (riesgo 5) | pendiente |
| 3 | Pruebas de integración contra MariaDB | Repetir `npm run test` apuntando `TEST_DATABASE_URL` a una base MariaDB de pruebas (hoy solo se corrieron con MySQL 8.0) | pendiente |
| 4 | Latencia real del cron de un minuto | Programar `npm run jobs:outbox` cada minuto y medir cuánto tarda en salir un correo de recuperación | pendiente |
| 5 | Limpieza programada | Programar `npm run jobs:cleanup` cada hora | pendiente |
| 6 | Correo: SPF, DKIM y DMARC | Enviar un correo de prueba a un buzón externo y revisar las cabeceras de autenticación; revisar los límites de envío del SMTP | pendiente |
| 7 | Entrega de correos | Tras unos días de piloto, `npm run report:email` (meta: más de 98 % entregados) | pendiente |
| 8 | Directorio de cédulas | Confirmar que `CEDULA_STORAGE_DIR` está **fuera de la raíz pública** y con permisos restringidos | pendiente |
| 9 | Proxy inverso | Definir `TRUST_PROXY` con el número de saltos del proxy del hosting (nunca `true`) y comprobar que la IP del cliente se lee bien | pendiente |
| 10 | Variables de entorno | Todas las de la tabla de arriba definidas en el panel del hosting, `APP_ENV=production` y SMTP completo | pendiente |

## Agenda del médico (feature 002)

La agenda no añade variables de entorno. Se usa `SESSION_SECRET` para firmar los boletos del selector de pacientes (con el prefijo de propósito `calendar-patient:`); rotar ese secreto invalida los boletos en curso (duran 15 minutos).

- **Migración**: `migrations/0009_calendar.sql` (cinco tablas y los disparadores de solo anexar de `calendar_action_log`). Como los de la feature 1, requieren `log_bin_trust_function_creators = 1` en el servidor local si el registro binario está activo.
- **Valores por defecto de un médico sin configuración**: 45 min de duración, 15 min de pausa, Ciudad de México, anticipación mínima de 2 horas y máxima de 60 días, sin horario de atención (no hay espacios hasta que guarde su horario).
- **Límites** (los repiten el formulario, zod y los CHECK de la base): duración 15–180 en pasos de 5; pausa 0–60 en pasos de 5; mínima 0 h–7 días y máxima 1–365 días con mínima menor que máxima; hasta 4 franjas por día sin solaparse.
- **Zonas permitidas**: America/Mexico_City, Cancun, Merida, Monterrey, Chihuahua, Ciudad_Juarez, Hermosillo, Mazatlan, Tijuana, Matamoros, Bahia_Banderas y Ojinaga. Requiere un Node con ICU completo (los oficiales lo traen; verificar en Hostinger con `node -e "console.log(Intl.supportedValuesOf('timeZone').includes('America/Tijuana'))"`).
- **Topes**: el personal consulta y agenda hasta 730 días adelante (y consulta hasta 365 atrás); un bloqueo dura como máximo 366 días.
- **Búsqueda de pacientes por correo**: 30 por hora por persona (con todos sus médicos) y 60 por hora por médico (se cuentan en `calendar_action_log`); se devuelve 429 con `Retry-After`.
- **Crear y cancelar citas**: 60 acciones por hora por persona (con todos sus médicos) y 5 citas creadas por hora por persona para un mismo paciente; 429 con `Retry-After`.
- **Retención del registro de acciones**: 90 días. La migración `0010_calendar_log_retention.sql` permite borrar solo filas de más de 90 días y `npm run jobs:cleanup` (cron, por ejemplo cada hora) las borra, hasta 10 000 por corrida.
- **Correos nuevos**: `appointment_created` y `appointment_cancelled` por el mismo outbox y cron de la feature 1 (sin tareas programadas nuevas).

### Humo de despliegue de la agenda (pendiente)
- [ ] `npm run migrate` aplica `0009_calendar.sql` en MariaDB (columna generada indexada y disparadores).
- [ ] Repetir contra MariaDB las pruebas de concurrencia de reservas, de cancelación y de bloqueos.
- [ ] Configurar el horario de un médico de prueba, agendar, cancelar y bloquear con conflicto, y ver llegar los dos correos con SMTP real.
- [ ] Comprobar que `Intl` conoce las zonas de la lista en el Node del hosting.
- [ ] Comprobar en MariaDB que el disparador de `0010` (IF … END IF en una sola sentencia) se crea y que `npm run jobs:cleanup` borra filas de más de 90 días y no las recientes.
