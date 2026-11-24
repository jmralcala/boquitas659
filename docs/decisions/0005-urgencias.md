# 0005 · Urgencias y triaje

Estado: implementado (feature 004), pendientes la validación del contenido médico por un dentista y el recorrido manual (T052). Fecha: 2026-11-23.
Origen: `specs/004-urgencias-y-triaje/` (spec, plan, research, data-model, contratos, quickstart), `0001-resumen-grill-me.md` (sección Urgencias) y la constitución v1.1.0 (principios I, III, IV y VI).

## Decisiones técnicas

- **La urgencia es una cita con `kind = 'urgent'`.** Hereda `withCalendarLock`, el índice único de cita vigente y la cancelación. Es lo único que se guarda del triaje: **no hay ninguna columna que guarde la categoría ni las señales de alarma** (lo prueba `urgent-schema.test.ts` recorriendo `information_schema`).
- **Horarios de urgencia.** Son franjas de `calendar_hours` con `kind = 'urgent'` (hasta 2 por día, sin solaparse con ninguna otra franja del mismo día). No aparecen en el calendario del paciente (`listFreeSlots`, mes y día) y la agenda del personal las marca «Urgencia». Si el personal agenda en un espacio de urgencia, la cita queda `regular`.
- **Asignación.** `findNearestUrgentSlot` (función pura) toma el espacio libre más próximo con `inicio ≥ ahora + anticipación de urgencias` e `inicio ≤ ahora + ventana del nivel` (bordes inclusivos); a igual inicio gana el de urgencia. Las anticipaciones de la reserva convencional no se aplican. `requestUrgent` corre bajo `withCalendarLock` con una sola lectura de citas y bloqueos y revalida con `assertSlotBookable`; el índice único es el respaldo.
- **Orden de comprobaciones.** Fuera del servicio: validación con zod, señales de alarma y CAPTCHA. Dentro del bloqueo: consultorio con servicio, paciente de la cuenta, doble envío (misma cuenta y paciente, urgencia vigente creada hace menos de 2 minutos: devuelve esa cita), una urgencia activa por paciente, 3 solicitudes por cuenta cada 24 h, autorización de datos y búsqueda. Una solicitud sin espacio **se cuenta** (fila `urgent_requested` rechazada, confirmando la transacción); una solicitud inválida, bloqueada por alarma o por CAPTCHA no se cuenta.
- **Señales de alarma.** «Dificultad para tragar o respirar» y «hinchazón cerca del ojo» bloquean la solicitud: se muestra solo el aviso de hospital y el móvil de emergencias, **antes** del CAPTCHA y sin llamar al servicio, registrar, contar ni avisar al médico. Decisión del responsable (2026-11-23).
- **La categoría solo vive en la cola de envío.** `doctor_urgent_notice` lleva `{ appointmentId, category }`; el outbox elimina las claves sensibles (`sensitiveKeys`) en la misma operación que marca el correo como enviado, y también al cancelarse o abandonarse (en ese caso encola `doctor_urgent_generic`). El job `expireUrgentCategories` (primer paso de `jobs:outbox`) convierte en genérico lo que lleve 24 h o más en cola. El aviso va al correo de la cuenta del médico, no a recepción, y nunca lleva el nombre del paciente.
- **Tabla de triaje provisional** (decisión del responsable): Rojo 2 h, Naranja 12 h, Amarillo 24 h, Verde claro 48 h y Verde 72 h. El contenido (`triage-content.ts`) está versionado y marcado `reviewedByDentist = false`: en producción el flujo **no se ofrece** hasta que un dentista lo valide y se cambie la bandera junto con una nueva versión.
- **Cancelación.** Una urgencia se cancela en cualquier momento antes de que termine, sin el plazo del consultorio; el tope de 10 cancelaciones por hora por cuenta sigue. Las urgencias no consumen las 5 reservas por hora ni las 3 citas vigentes de la reserva convencional, y los recordatorios solo se encolan para citas convencionales.
- **CAPTCHA: Cloudflare Turnstile verificado con `fetch`** (sin dependencias nuevas). Falla cerrado: si el proveedor no responde, la persona ve el móvil de emergencias y el teléfono del consultorio. El proveedor solo recibe el token y la IP. La CSP se amplía solo en la ruta de urgencia. En producción sin claves la urgencia no se ofrece.

## Valores y límites

| Valor | Límite |
|-------|--------|
| Urgencia activa | 1 por paciente (cita `urgent` vigente que aún no empieza) |
| Solicitudes por cuenta | 3 cada 24 horas, entre consultorios, contando las «sin espacio» |
| Doble envío | misma cuenta y paciente en menos de 2 minutos: devuelve la misma cita |
| `POST /c/:slug/urgencia` | 10 por hora por IP |
| `GET /c/:slug/urgencia` | 120 por minuto por IP |
| Anticipación mínima de urgencias | 30 minutos por defecto (0 a 1440), configurable por el médico |
| Franjas de urgencia | hasta 2 por día |
| Cancelaciones | 10 por hora por cuenta (sin plazo para urgencias) |
| Categoría en la cola | se elimina al enviarse, cancelarse, abandonarse o a las 24 h como máximo |

## Riesgos abiertos

- **Contenido médico provisional.** Las categorías, ventanas, descripciones, primeros auxilios, el aviso de hospital y la pregunta de señales de alarma los valida un dentista antes de producción (constitución). Hasta entonces las urgencias no están disponibles en producción, ni siquiera para el piloto.
- **Dependencia del CAPTCHA de un tercero.** Turnstile recibe la IP del visitante y el token. Su script cambia continuamente, por lo que **no admite integridad de subrecurso (SRI)**: riesgo aceptado, acotado por la CSP de esa sola ruta y por el modo que falla cerrado.
- **Móvil de emergencias sin verificación por WhatsApp.** La verificación es posterior al piloto; se muestra el móvil registrado de un médico aprobado, solo a pacientes con sesión y solo en las pantallas de «sin espacio», alarma y CAPTCHA no disponible.
- **Límite por cuenta entre consultorios.** Los límites son exactos con un mismo consultorio (se cuentan bajo su bloqueo) y blandos entre consultorios: dos solicitudes simultáneas a médicos distintos pueden excederlo por una.
- **Límite por IP en memoria.** Igual que el resto de la aplicación: con varias instancias se multiplica.
- **Medición del piloto.** SC-008 solo puede comparar solicitudes «agendadas» con «sin espacio»: las señales de alarma y el CAPTCHA no disponible no se registran por diseño.
- **Entrega a tiempo con el cron del hosting.** El aviso al médico sale en el siguiente ciclo de `jobs:outbox` (cada minuto); falta medirlo en el despliegue real (SC-003).
- **MariaDB y Hostinger.** La migración `0013` y los escenarios de concurrencia están probados en MySQL 8; falta repetirlos en MariaDB (T052).
