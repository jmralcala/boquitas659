# Contrato: correos del micrositio y las citas del paciente

Mismo mecanismo que las features 1 y 2: `email_outbox`, envío por cron, al menos una vez, español, asunto sin datos
personales y sin adjuntos; ninguno lleva datos clínicos. Se encolan **en la misma transacción** que la mutación.
Los correos del consultorio al paciente salen del remitente de la plataforma con **el médico como `Reply-To`**
(correo de su cuenta). Los enlaces con token se crean al enviar (patrón de la feature 1); abrirlos nunca cambia el estado.

## Plantillas nuevas

| Plantilla | Destinatario | Disparador | Contenido | Enlace |
|-----------|--------------|------------|-----------|--------|
| `appointment_reminder` | Cuenta del paciente (el tutor, si es menor) | Tarea de cron: 6 h antes del límite de cancelación (30 h con el límite de 24 h), una sola vez por cita | Asunto «Recordatorio de tu cita dental». Médico, fecha y hora en la zona del consultorio, dirección, teléfono, y hasta cuándo se puede cancelar. `shouldSend`: la cita sigue vigente | `/citas/enlace/<token>` (propósito `appointment_reminder`) |
| `appointment_cancelled_by_patient` | Cuenta del paciente | El paciente cancela, o revoca su vínculo | Asunto «Cancelaste tu cita dental» (constancia): médico, fecha y hora que tenía, teléfono para dudas | — |
| `doctor_appointment_booked` | Correo de la cuenta del **médico** | El paciente reserva | Asunto «Nueva cita agendada». Nombre del paciente, fecha, hora y etiqueta «convencional»; sin teléfono ni correo del paciente | `/agenda/dia/<fecha>` (inicio de sesión) |
| `doctor_appointment_cancelled` | Correo de la cuenta del **médico** | El paciente cancela o revoca su vínculo | Asunto «Cita cancelada por el paciente». Nombre, fecha, hora y, si fue por revocación, «el paciente retiró su vínculo con el consultorio» | `/agenda/dia/<fecha>` |
| `patient_linked_by_office` | Cuenta del paciente | El personal vincula a la cuenta al agendarle una cita (feature 2) | Asunto «Un consultorio agendó una cita para ti». Consultorio, fecha de la cita, qué datos ve el consultorio y cómo revocar el vínculo | `/pacientes/consultorios` (inicio de sesión) |

## Plantillas de la feature 2 que cambian

| Plantilla | Cambio |
|-----------|--------|
| `appointment_created` | Ahora incluye la **dirección** del consultorio, el enlace `/citas/enlace/<token>` (propósito `appointment_confirmation`) y el `Reply-To` del médico. Se envía tanto a las citas creadas por el paciente como a las del personal. Se retira la regla «sin enlaces» de la feature 2 |
| `appointment_cancelled` | Se añade el `Reply-To` del médico (cancelación por el consultorio) |

## Reglas

- `payload = { appointmentId }` (y `{ appointmentId, reason }` en la cancelación por revocación); el outbox nunca guarda
  nombres ni horas.
- Un token por propósito y cita: el del recordatorio no invalida el de la confirmación. Cancelar la cita deja ambos sin
  efecto (responden 410 genérico).
- `appointment_created` y `appointment_reminder` llevan `shouldSend` con `FOR UPDATE` sobre la cita: si ya no está
  vigente no se envían. Las plantillas del médico y de constancia no lo necesitan.
- El correo del paciente es el de la **cuenta** al momento de enviar (comportamiento de la feature 1); si el paciente
  cambió de correo, el outbox conserva el destinatario con que se encoló.
- Reintentos y abandono como en la feature 1; si un correo falla, la cita no se deshace.
- El aviso al médico va al correo de su cuenta, no a recepción, y lleva solo el nombre del paciente.
