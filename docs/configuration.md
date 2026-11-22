# Configuración (variables de entorno)

Todas se leen una sola vez al arrancar (`src/config/env.ts`) y se validan con zod. Los valores de ejemplo son
ficticios. **Nunca** se commitean valores reales; para desarrollo se usa un `.env` local (ignorado por git).

> `.env.example` debe actualizarse a mano con los nombres de esta lista (esta herramienta no puede leerlo por política
> de permisos del proyecto).

| Variable | Obligatoria | Propósito | Ejemplo |
|----------|-------------|-----------|---------|
| `APP_ENV` | sí | `development` o `production`. En `production` los avisos legales provisionales bloquean altas | `development` |
| `PUBLIC_BASE_URL` | sí | URL base para construir enlaces de correo | `http://localhost:3000` |
| `TRUST_PROXY` | no (`false`) | Confianza en el proxy inverso del hosting para leer la IP real del cliente en los límites de peticiones. `false` (o `0`): no se confía en `X-Forwarded-For`. Un entero de 1 a 10: número de saltos del proxy propio. O una lista de IP/CIDR separada por comas. **Nunca `true`**: permitiría falsificar la IP y evadir el límite | `1` |
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
