# Contrato: correos transaccionales

Todos salen de la plataforma por SMTP (remitente propio, SPF/DKIM/DMARC) a través de `email_outbox`. Ninguno lleva
adjuntos. Ningún correo incluye contraseñas, categoría de urgencia ni datos clínicos. Los enlaces con token apuntan a
una pantalla que muestra el resumen y un botón; abrirlos nunca cambia el estado.

| Plantilla | Destinatario | Disparador | Contenido | Enlace |
|-----------|--------------|------------|-----------|--------|
| `support_new_doctor` | `soporte@innvend.com` | Médico envía su solicitud | Aviso de solicitud pendiente, sin datos de la cédula ni adjuntos | Panel de soporte (`/soporte/medicos/:id`) |
| `doctor_approved` | Médico | Soporte aprueba | Aprobación y fecha de fin de la prueba de 5 días | Inicio de sesión |
| `doctor_rejected` | Médico | Soporte rechaza | Motivo y cómo reenviar | `/medicos/estado` |
| `password_reset` | Usuario | Solicita recuperación (si la cuenta existe) | Enlace de un solo uso, caduca en 30 minutos | `/recuperar/:token` |
| `password_changed` | Titular | Cambio de contraseña | Aviso de cambio y qué hacer si no fue él o ella | `/recuperar` |
| `new_device_login` | Titular | Inicio de sesión desde dispositivo nuevo | Fecha y hora, aviso genérico | `/cuenta/contrasena` |
| `email_changed_old` / `email_changed_new` | Correo anterior y nuevo | Cambio de correo | Aviso de cambio; el nuevo recibe confirmación | — |
| `mfa_enabled` / `mfa_disabled` | Titular | Cambio de doble factor | Aviso | — |
| `reception_invitation` | Invitado | Médico invita | Quién invita (nombre del médico), caducidad de 7 días | `/recepcion/invitacion/:token` |
| `reception_joined` | Médico | Invitado acepta | Aviso de que la persona ya tiene acceso | `/medicos/recepcion` |
| `reception_removed` | Persona de recepción | Médico retira el acceso | Aviso de que ya no tiene acceso | — |

## Reglas

- Texto en español; asunto sin datos personales.
- `Reply-To` solo para correos que vengan del médico a pacientes (feature 3); aquí no se usa.
- Reintentos con espera creciente (máximo definido en configuración); tras agotarlos queda `failed` y se registra el
  código, sin el cuerpo.
- Meta del piloto: más de 98 % de entrega.
