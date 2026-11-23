# Contrato: correos de la agenda

Mismo mecanismo que [la feature 1](../../001-cuentas-y-acceso/contracts/email-notifications.md): `email_outbox`, envío
por cron, al menos una vez, español, asunto sin datos personales y sin adjuntos. Ninguno lleva enlaces de acción ni
datos clínicos. Se encolan en la **misma transacción** que la mutación.

| Plantilla | Destinatario | Disparador | Contenido | Enlace |
|-----------|--------------|------------|-----------|--------|
| `appointment_created` | Correo de la cuenta del paciente (el tutor, si el paciente es un menor) | El médico o su recepción crean una cita | Asunto «Tu cita dental fue agendada». Cuerpo: nombre del médico, fecha y hora en la zona del consultorio, teléfono del consultorio si existe y nombre de la persona para quien es la cita | — |
| `appointment_cancelled` | Igual | El médico o su recepción cancelan una cita | Asunto «Tu cita dental fue cancelada». Cuerpo: médico, fecha y hora que tenía, aviso de que el consultorio la canceló y cómo contactarlo | — |

## Reglas

- `payload = { appointmentId }`; el outbox nunca guarda nombres ni horas.
- `appointment_created` lleva `shouldSend`: dentro de la transacción de envío bloquea la cita (`FOR UPDATE`) y
  cancela el correo si ya no está `booked`, para que nunca llegue «agendada» después de «cancelada».
- `appointment_cancelled` siempre se envía (la cancelación ya ocurrió).
- Si la cuenta del paciente cambió de correo entre el encolado y el envío, el destinatario ya guardado en el outbox
  es el que vale (comportamiento de la feature 1, aceptado).
- Reintentos con espera creciente y abandono tras los intentos definidos en configuración; si el correo no sale, la
  cita no se deshace (queda en el informe de entregas de la feature 1).
- `Reply-To`: el correo del médico no se usa en esta feature (se añade con el micrositio y los mensajes del médico,
  feature 3).
