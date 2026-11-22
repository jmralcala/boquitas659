# Configuración (variables de entorno)

Todas se leen una sola vez al arrancar (`src/config/env.ts`) y se validan con zod. Los valores de ejemplo son
ficticios. **Nunca** se commitean valores reales; para desarrollo se usa un `.env` local (ignorado por git).

> `.env.example` debe actualizarse a mano con los nombres de esta lista (esta herramienta no puede leerlo por política
> de permisos del proyecto).

| Variable | Obligatoria | Propósito | Ejemplo |
|----------|-------------|-----------|---------|
| `APP_ENV` | sí | `development` o `production`. En `production` los avisos legales provisionales bloquean altas | `development` |
| `PUBLIC_BASE_URL` | sí | URL base para construir enlaces de correo | `http://localhost:3000` |
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
