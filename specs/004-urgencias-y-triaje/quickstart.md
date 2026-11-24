# Quickstart: validación de urgencias y triaje

Guía de validación de la feature 4. Cada escenario es una prueba automática (vitest) y, salvo el último bloque, se puede
repetir a mano con el servidor local.

## Prerrequisitos

- Base de pruebas MySQL 8 con las migraciones `0001`–`0013` aplicadas (`npm run migrate`), como en las features anteriores.
- `TEST_DATABASE_URL` en `.env` (lo creó el usuario). Un médico aprobado con micrositio publicado, horario convencional,
  franjas de urgencia, teléfono del consultorio y móvil de emergencias, y una cuenta de paciente (los factories de
  `tests/integration/helpers/db.ts`).
- Las pruebas **inyectan un verificador de CAPTCHA falso** (válido, inválido o no disponible); no llaman al proveedor. A mano:
  claves de prueba oficiales de Turnstile en `TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY`.
- Vitest por PowerShell con la ruta `C:\…`. Reloj fijo (`FixedClock`): fijarlo **antes** de abrir las sesiones.

## Comandos

```text
npm run lint · npm run typecheck · npm run test · npm run build
```

## Escenarios

### Horarios de urgencia del médico (historia 3)
1. El médico guarda franjas de urgencia (hasta 2 por día) y una anticipación mínima de urgencias (30 min por defecto).
2. Una franja de urgencia que se solapa con una convencional del mismo día se rechaza con mensaje claro; ninguna se guarda.
3. Valores fuera de rango (anticipación negativa o mayor a 1440, fin ≤ inicio, cruzar la medianoche): 400 sin guardar.
4. Recepción intenta cambiarlos: 403.
5. El calendario convencional del paciente **no** ofrece los espacios de urgencia; la agenda del personal los marca «Urgencia».
6. Cambiar las franjas no toca citas ya agendadas.

### Asignación del espacio (historia 1)
7. Un espacio libre por nivel: cada categoría recibe el espacio libre **más próximo** dentro de su ventana (Rojo 2 h, Naranja 12 h,
   Amarillo 24 h, Verde claro 48 h, Verde 72 h; valores provisionales) con `inicio >= ahora + anticipación mínima de urgencias`.
8. El borde de la anticipación (justo a los 30 min) y el borde de la ventana son inclusivos; un minuto antes del primero o
   después del segundo, no.
9. Con un espacio de urgencia y uno convencional a la misma hora gana el de urgencia; si el convencional es más próximo, gana
   el convencional.
10. Nunca se asigna un espacio ocupado, bloqueado, pasado ni fuera del horario; una urgencia no desplaza citas.
11. El paciente no ve calendario ni lista de horarios en ningún punto del flujo (ni en el HTML ni en el JSON).
12. La cita queda `kind = urgent`, con `created_by_role = patient`, y la agenda del médico y de recepción la muestra con la
    etiqueta «Urgencia» y **sin categoría**.
13. Cambio de hora en la zona del consultorio: sin espacios duplicados ni perdidos.
14. Paciente adicional: la cita queda a nombre del menor con la autorización del tutor.
15. Sin la casilla de autorización cuando no hay una activa: 400 sin cita.

### Sin espacio y señales de alarma (historia 2)
16. Sin ningún espacio libre en la ventana: pantalla «no encontramos espacio» con el móvil de emergencias del médico (o el
    teléfono del consultorio si no tiene) y, en el nivel alto, el aviso de hospital; no se crea cita ni correo; la solicitud
    **cuenta** para las 3 por 24 h.
17. Con espacios convencionales libres pero sin franjas de urgencia: se usa el convencional más próximo en la ventana.
18. Una señal de alarma marcada: pantalla de emergencia (aviso de hospital y móvil de emergencias); no se verifica el CAPTCHA, no
    se llama al servicio, no se registra nada, no cuenta para el límite, no se avisa al médico y no queda rastro de que se marcó.
19. El móvil de emergencias solo aparece a pacientes con sesión en esas pantallas; el micrositio público no lo muestra.

### Protecciones contra abuso (historia 4)
20. Una urgencia vigente por paciente: la segunda es 409 `urgent_active`; tras cancelar la primera, se permite.
21. Tres solicitudes por cuenta en 24 h (con o sin espacio): la cuarta es 429 con la hora de reintento; pasadas 24 h, se permite.
22. CAPTCHA inválido: 400 sin buscar espacio y sin contar; CAPTCHA no disponible: pantalla con móvil de emergencias y teléfono del
    consultorio (falla cerrado), sin cita.
23. Más de 10 solicitudes por hora desde una IP: 429.
24. Doble envío del formulario: 303 a la misma cita, sin segunda cita ni segundo correo y sin contar dos veces.
25. Las urgencias no consumen las 5 reservas por hora ni las 3 citas vigentes de la feature 3, y viceversa.

### Concurrencia (obligatoria, constitución III y V)
26. 20 solicitudes simultáneas de pacientes distintos con **un solo** espacio libre en la ventana: exactamente una cita; las demás
    reciben «sin espacio»; nunca dos citas vigentes en el mismo espacio.
27. Urgencia contra bloqueo del médico sobre el único espacio (20 rondas): nunca una cita dentro de un bloqueo.
28. Urgencia contra una reserva convencional del mismo espacio: una gana, la otra recibe conflicto o el siguiente espacio.
29. Urgencia contra la cancelación de una cita que libera el espacio: como máximo una cita vigente; sin pérdidas.
30. Una ráfaga de 5 solicitudes de la misma cuenta deja pasar exactamente 3 (el límite no se elude).

### Avisos y categoría efímera (historia 5)
31. Al agendar: el paciente recibe `appointment_created` con el médico como Reply-To, enlace y **sin categoría**; el médico recibe
    `doctor_urgent_notice` (categoría, día y hora, sin nombre del paciente ni datos de contacto) en su correo de cuenta, no en el
    de recepción.
32. Tras entregarse el aviso, la categoría ya no está en `email_outbox.payload_ref`.
33. Si la urgencia se cancela antes del envío: el aviso no sale, la fila queda `cancelled` y sin categoría.
34. Si el envío falla definitivamente: la categoría se borra y el médico recibe `doctor_urgent_generic`.
35. Si la fila lleva más de 24 h en cola: `urgent-notices` borra la categoría y la convierte en `doctor_urgent_generic`; correrlo
    varias veces no duplica.
36. Prueba de privacidad: tras recorrer todos los flujos, ninguna tabla, registro técnico, fila de `calendar_action_log`, cuerpo
    de correo al paciente ni métrica contiene la categoría (se recorren todas las tablas de la base y la salida del logger).
37. El aviso al médico sale en el siguiente ciclo de `jobs:outbox` (prueba con el procesador y reloj controlado).

### Cancelación (historia 6)
38. El paciente cancela una urgencia que empieza en menos de 24 h: se permite, el espacio queda libre y el médico recibe el aviso
    de cancelación (sin categoría); una cita convencional dentro del plazo sigue sin poder cancelarse.
39. Una urgencia ya iniciada o pasada no se cancela (409); la cancelación por el enlace del correo sigue las reglas de la feature 3.

### Disponibilidad y contenido (historia 7)
40. Micrositio despublicado, médico no aprobado o cuenta en solo lectura: 403/pantalla «confirma por teléfono»; ningún espacio se asigna.
41. En `APP_ENV=production` con el contenido provisional: el flujo no se ofrece y se muestra el teléfono del consultorio; con
    `reviewedByDentist = true` en la versión vigente, se ofrece.
42. Sin claves del CAPTCHA en producción: el flujo no se ofrece (teléfono del consultorio).

### Aislamiento
43. Un paciente no ve ni cancela urgencias de otra cuenta (404); el personal con sesión no pide urgencias (403); un `doctorId` o
    `patientId` manipulado no cambia a quién se agenda; ningún `GET` de `/c/` cambia el estado.

## Pasos manuales (requieren a una persona; ver la tarea final de `tasks.md`)

- Recorrido en navegador con SMTP real y el widget de Turnstile con claves reales.
- En el despliegue de pruebas de Hostinger: aplicar `0013_urgent.sql` en MariaDB, repetir los escenarios de concurrencia (26–30),
  comprobar que `jobs:outbox` (cron por minuto) entrega el aviso al médico en menos de 3 minutos y que el borrado de la categoría y
  el aviso genérico funcionan con el cron real.
- Validación del contenido del triaje (categorías, ventanas, primeros auxilios, aviso de hospital y señales de alarma) por un
  dentista, y cambio de `reviewedByDentist` con su versión.
- Medir en el piloto la proporción de urgencias con espacio frente a «llama al médico» (SC-008).
