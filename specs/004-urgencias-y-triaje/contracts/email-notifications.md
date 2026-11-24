# Contrato: correos de urgencias

Mismo mecanismo que las features 1 a 3: `email_outbox`, envío por cron cada minuto (`jobs:outbox`), al menos una vez, español,
asunto sin datos personales y sin adjuntos. Se encolan **en la misma transacción** que la cita. Los avisos de urgencia **no se
bloquean por cuota ni por plan**. Los del consultorio al paciente salen con el médico como `Reply-To`.

## Plantillas

| Plantilla | Destinatario | Disparador | Contenido | Enlace |
|-----------|--------------|------------|-----------|--------|
| `appointment_created` (feature 2, cambia) | Cuenta del paciente (el tutor, si es menor) | Se agenda una urgencia | Asunto «Tu cita dental fue agendada». Para una cita `urgent`: «Tu cita de urgencia con <médico> quedó agendada…», día y hora en la zona del consultorio, dirección, teléfono y quién es el paciente. **Sin categoría** | `/citas/enlace/<token>` (propósito `appointment_confirmation`) |
| `doctor_urgent_notice` | Correo de la cuenta del **médico** (no recepción) | Se agenda una urgencia | Asunto «Nueva urgencia agendada». **Categoría** (nombre del semáforo), día y hora; **sin nombre del paciente ni datos de contacto**. Con `shouldSend` sobre la cita (si ya se canceló, no se envía) | `/agenda/dia/<fecha>` (inicio de sesión) |
| `doctor_urgent_generic` | Correo de la cuenta del médico | Falla definitiva del `doctor_urgent_notice` o pasan 24 h sin entregarse | Asunto «Tienes una urgencia agendada». «Revisa tu agenda»; **sin categoría**, día ni hora detallados más allá del enlace | `/agenda/dia/<fecha>` |
| `doctor_appointment_cancelled` (feature 3, sin cambios) | Correo de la cuenta del médico | El paciente cancela una urgencia | Nombre, fecha y hora; sin categoría | `/agenda/dia/<fecha>` |
| `appointment_cancelled_by_patient` (feature 3, sin cambios) | Cuenta del paciente | El paciente cancela | Constancia | — |

## Ciclo de vida de la categoría

`doctor_urgent_notice` es la **única** plantilla con `sensitiveKeys: ["category"]`. El `payload` es `{ appointmentId, category }`
con `category` ∈ `rojo` \| `naranja` \| `amarillo` \| `verde_claro` \| `verde`.

| Estado final de la fila | Qué ocurre con `category` |
|-------------------------|---------------------------|
| `sent` | Se elimina del `payload_ref` en la misma transacción que marca el envío |
| `cancelled` | Se elimina al marcar la fila cancelada |
| `failed` (reintentos agotados) | Se elimina y se encola `doctor_urgent_generic` |
| `queued` con más de 24 h | `urgent-notices` (primer paso de `jobs:outbox`) la elimina y convierte la fila en `doctor_urgent_generic`; idempotente |

## Reglas

- Los registros técnicos del outbox (`send_failed`, `gave_up`, `cancelled`) solo llevan id, plantilla e intentos: nunca el
  `payload`; el cuerpo enviado nunca se guarda.
- El aviso al médico nombra la categoría **del semáforo** (un texto fijo de la lista), nunca texto libre del paciente.
- `appointment_created` de una urgencia no incluye la categoría ni el nivel: el paciente ya conoce lo que eligió y no se
  reproduce en correos que pueden reenviarse.
- Si el correo al paciente falla, la cita no se deshace; si falla el del médico, se aplica la regla del aviso genérico.
- Un correo al médico puede salir después de que la urgencia se cancele solo si ya había salido antes; `shouldSend` lo evita
  si todavía estaba en cola.
