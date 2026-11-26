# Quickstart: validación del micrositio y la reserva del paciente

Guía de validación de la feature 3. Cada escenario es una prueba automática (vitest) y, salvo el último bloque, se puede
repetir a mano con el servidor local.

## Prerrequisitos

- Base de pruebas MySQL 8 con las migraciones `0001`–`0011` aplicadas (`npm run migrate`), como en las features anteriores.
- `TEST_DATABASE_URL` en `.env` (lo creó el usuario). Un médico aprobado con horario configurado y teléfono del
  consultorio, y una cuenta de paciente (los crean los factories de `tests/integration/helpers/db.ts`).
- Vitest por PowerShell con la ruta `C:\…`. Reloj fijo (`FixedClock`): fijarlo **antes** de abrir las sesiones.

## Comandos

```text
npm run lint · npm run typecheck · npm run test · npm run build
```

## Escenarios

### Publicar el micrositio (historia 1)
1. El médico elige un nombre libre válido; queda guardado y no se puede cambiar por él mismo.
2. Dos médicos eligen el mismo nombre a la vez: uno lo obtiene, el otro recibe `slug_taken`.
3. Nombres inválidos (mayúsculas, acentos, espacios, `-abc`, `a--b`, 2 o 41 caracteres): 400 con reglas.
4. Publicar sin dirección, sin teléfono del consultorio o sin franjas: 409 con la lista de lo que falta.
5. Logo: PNG/JPEG/WebP válido se guarda; un `.png` que en realidad es otro contenido, un SVG o uno de más de 1 MB: 400 sin guardar.
6. Recepción, médico pendiente o paciente intentan administrar: 403.
7. Un nombre nunca publicado responde 404 idéntico a una ruta inexistente; despublicado, aviso con el teléfono.

### Entrada del paciente (historia 2)
8. Sin sesión: el micrositio muestra consultorio, dirección con enlace «Cómo llegar» y las dos opciones, sin horarios ni datos de pacientes.
9. «Ya soy paciente» con contraseña correcta: sesión y calendario; incorrecta: 401 con espera creciente; sin cuenta: 401 `no_account` y oferta de «Primera cita».
10. Un correo de médico, recepción o soporte se trata como inexistente (misma respuesta que `no_account`).
11. «Primera cita» sin la casilla de privacidad: 400; con ella, cuenta creada, aceptación registrada y sesión iniciada.
12. 11 intentos por minuto desde la misma IP: el 11.º recibe 429.

### Reservar (historia 3)
13. El calendario no ofrece fechas pasadas ni posteriores a la anticipación máxima, y la lista del día respeta la mínima.
14. Reservar un horario libre: la cita queda agendada, aparece en la agenda del médico (nombre del paciente) y el horario deja de ofrecerse.
15. Manipular la petición (horario fuera de anticipación, ocupado, bloqueado, no existente, micrositio despublicado): el servidor rechaza.
16. **Concurrencia**: 20 reservas simultáneas del mismo horario por pacientes distintos: exactamente una cita y 19 `slot_unavailable`; reserva contra bloqueo del médico, contra cancelación del personal y contra revocación: nunca una cita dentro de un bloqueo ni dos citas vigentes.
17. Reservar para un paciente adicional propio funciona; para uno de otra cuenta, 404.
18. Primera reserva con un consultorio: sin la casilla `autorizo`, 400; con ella, queda una autorización registrada (cuenta, consultorio, versión del aviso, quién y cuándo); la segunda reserva ya no la pide.
19. Límites: la 6.ª reserva en una hora y la 4.ª cita vigente con el mismo consultorio y paciente se rechazan con 429/409 y mensaje claro.
20. Sesión caducada a mitad de la reserva: al volver a iniciar sesión regresa al calendario del mismo consultorio.

### Correos y enlaces (historia 4)
21. Al reservar salen, por el outbox: confirmación al paciente (con dirección, enlace y `Reply-To` del médico) y aviso de cita nueva al médico (solo nombre, fecha, hora y etiqueta).
22. Abrir el enlace de la confirmación 100 veces (también con una petición sin sesión o de otra cuenta): la cita no cambia; con otra cuenta no se ve ningún dato.
23. Token vencido, usado, manipulado o de una cita cancelada: 410 genérico.
24. Si la cita se cancela antes de enviarse la confirmación, ese correo se cancela.

### Mis citas y cancelación (historia 5)
25. «Mis citas» muestra solo las citas de las personas de la cuenta, próximas y de los últimos 90 días.
26. Cancelar con más anticipación que el límite: horario libre, aviso al médico y constancia; justo en el límite (inclusive) se permite; un minuto después, 409 con el teléfono.
27. Cancelar desde el enlace sin sesión pide iniciar sesión y regresa al resumen; solo `POST` con CSRF cancela y consume el token.
28. Cancelar dos veces o dos cancelaciones simultáneas: una prospera y un solo aviso.
29. Cambiar el límite de cancelación del consultorio afecta solo a cancelaciones futuras.

### Recordatorio (historia 6)
30. Una cita a 30 horas o menos recibe un solo recordatorio aunque el cron se ejecute varias veces o dos procesos a la vez.
31. Sin recordatorio para citas canceladas, citas reservadas con menos anticipación que el momento del recordatorio, o ya pasadas; con límite de 48 h el recordatorio sale 54 h antes.
32. Las citas creadas por el personal también reciben recordatorio.

### Mis consultorios y revocación (historia 7)
33. Un vínculo creado por el personal envía `patient_linked_by_office`, aparece como «Lo creó el consultorio» y el paciente puede revocarlo.
34. Revocar: confirmación previa con el número de citas; al confirmar, las citas futuras de la cuenta con ese consultorio se cancelan, el médico recibe un aviso por cada una, los horarios se liberan y el consultorio ya no ve el contacto (`/agenda/pacientes/:id` responde 404) pero conserva los nombres en las citas pasadas.
35. Tras revocar, el personal no puede agendar a esa cuenta con el boleto (404); el paciente sí puede volver a reservar, con una nueva autorización.

### Seguridad y aislamiento
36. Cada ruta: sin sesión, rol no permitido (403), ajena (404), sin CSRF (403) y validación (400); ninguna ruta pública devuelve datos de pacientes.
37. Una función de agenda del personal no acepta un contexto de paciente (error de compilación: `StaffContext`); el paciente no llega a `/agenda/…` (403).
38. Los registros técnicos de las pruebas no contienen nombres, correos ni teléfonos.
39. `data_authorization` rechaza `UPDATE` y `DELETE`.
40. El enlace «Cómo llegar» abre la dirección en una pestaña nueva; la página no incrusta marcos de terceros y la CSP no cambia.

## Validación manual (con una persona)

- Recorrido en el navegador con SMTP real: publicar, reservar como paciente nuevo y como existente, ver los correos
  (confirmación, aviso al médico, recordatorio al adelantar el reloj de la base de pruebas), cancelar desde el enlace,
  revocar un vínculo. Se anota en `tasks.md` como último paso, igual que T062 de la feature 2.
- En el despliegue (Hostinger): comprobar la migración `0011` en MariaDB, repetir los escenarios de concurrencia
  (16), comprobar el enlace «Cómo llegar» con una dirección real, y que `jobs:outbox` (cron por minuto) envía los recordatorios.
