# Contrato: correos del panel de soporte

Mismo mecanismo que las features 1 a 4: `email_outbox`, envío por cron cada minuto (`jobs:outbox`), al menos una vez, español,
asunto sin datos personales y sin adjuntos. Se encolan **en la misma transacción** que el cambio de estado. Los textos son
**fijos y provisionales** hasta la revisión legal y **nunca incluyen el motivo interno** que escribió soporte.

## Plantillas

| Plantilla | Destinatario | Disparador | Contenido | Enlace |
|-----------|--------------|------------|-----------|--------|
| `doctor_account_suspended` | Correo de la cuenta del médico | Soporte suspende la cuenta | Asunto «Tu cuenta fue suspendida». «Tu acceso y las reservas en línea están pausados. Si crees que es un error, responde a este correo o escribe a soporte.» Sin motivo | — |
| `doctor_account_read_only` | Correo de la cuenta del médico | Soporte pasa la cuenta a solo lectura | Asunto «Tu cuenta está en solo lectura». «Puedes consultar tu agenda, pero no modificarla, y tu micrositio no acepta reservas nuevas. Las citas agendadas se conservan.» Sin motivo | `/agenda` |
| `doctor_account_reactivated` | Correo de la cuenta del médico | Soporte reactiva la cuenta | Asunto «Tu cuenta fue reactivada». «Ya puedes usar tu agenda y tu micrositio como antes.» Sin motivo | `/medicos/panel` |
| `doctor_site_slug_changed` | Correo de la cuenta del médico | Soporte cambia el nombre del enlace | Asunto «Cambió el enlace de tu micrositio». El enlace nuevo y «el anterior dejó de funcionar»; sin motivo | el enlace nuevo `/c/<nombre>` |
| `doctor_cedula_released` (feature 1) | Correo de la cuenta del médico | Soporte libera la cédula | Sin cambios: mensaje fijo | — |

Las plantillas se registran en `src/mail/templates.ts` junto a las de las features anteriores. Ninguna lleva
`sensitiveKeys`: su `payload` es solo `{ doctorId }` (y `slug` en el cambio de enlace).

## Restricciones

- El aviso de soporte por solicitud nueva (feature 1) no cambia.
- Reintentar un correo desde el panel **no** modifica su `payload`; los tipos con claves sensibles
  (`doctor_urgent_notice`) no se reintentan y su fila fallida ya fue reemplazada por `doctor_urgent_generic`.
- Los correos de estado de cuenta no pasan por cuotas ni por plan.
