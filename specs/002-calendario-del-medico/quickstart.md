# Quickstart: validación de la agenda

Guía de validación de la feature 2. Cada escenario es una prueba automática (vitest) y, salvo el último bloque, se
puede repetir a mano con el servidor local.

## Prerrequisitos

- Base de pruebas MySQL 8 con las migraciones `0001`–`0009` aplicadas (`npm run db:migrate`), como en la feature 1.
- `TEST_DATABASE_URL` en `.env` (lo creó el usuario) y, para pruebas manuales, un médico aprobado, una persona de
  recepción vinculada y un paciente con cuenta (los crean los factories de `tests/integration/helpers/db.ts`).
- Ejecutar vitest por PowerShell con la ruta `C:\…` (no desde Git Bash). Reloj fijo (`FixedClock`) en todas las
  pruebas con fechas.

## Comandos

```text
npm run lint · npm run typecheck · npm run test · npm run build
```

## Escenarios

### Configuración (historia 1)
1. Médico nuevo: la pantalla muestra los valores por defecto (45/15, México, 2 h, 60 días) y ninguna franja, sin espacios.
2. Guardar lunes a viernes 9–14 y 16–19: la semana siguiente muestra espacios solo en esas franjas y días; con 45 + 15 los
   inicios son 9:00, 10:00, 11:00, 12:00, 13:00 (el de 13:00 termina 13:45) y 16:00, 17:00, 18:00.
3. Franja que termina a mitad de un espacio (9:00–10:30): el espacio de 10:00 no se genera.
4. Valores inválidos (duración 0 o 17, intervalo 7, franjas solapadas, fin antes del inicio, mínima ≥ máxima, zona
   inexistente, más de 4 franjas): 400 con mensaje por campo y nada guardado.
5. Recepción intenta ver o guardar la configuración: 403.
6. Cambiar la configuración con citas existentes (otra duración, otro horario, menor anticipación máxima): las citas
   siguen intactas y aparecen marcadas si quedan fuera del horario.
7. Reducir la duración de 45 a 30 sin intervalo: una cita 9:00–9:45 hace que el espacio 9:30 aparezca ocupado y no se
   pueda reservar.

### Agenda (historia 2)
8. Un día con espacio libre, cita y bloqueo: cada estado se muestra bien; la cita muestra el nombre, no más.
9. Vista semanal y navegación a semanas vecinas; espacios pasados no se ofrecen.
10. Recepción con dos médicos: al cambiar de médico activo solo ve la agenda de ese médico.
11. Vínculo de recepción retirado: 403 en la misma petición.
12. Cambio de hora (zona con horario de verano, p. ej. `America/Tijuana`): el día con hora inexistente no genera
    espacios en ella y el día con hora repetida no duplica espacios.

### Crear cita (historia 3)
13. Espacio libre + paciente vinculado: cita creada, espacio ocupado, correo `appointment_created` encolado.
14. Paciente aún no vinculado hallado por correo exacto: el boleto crea el vínculo en la misma transacción; sin boleto,
    o con boleto de otro médico, otro actor o vencido: 404.
15. Menor bajo un tutor: la cita queda a nombre del menor y el correo va a la cuenta del tutor.
16. Espacio ocupado, bloqueado, pasado o fuera de horario/cuadrícula: rechazo (409 o 400) y calendario intacto.
17. **Concurrencia**: 20 creaciones simultáneas del mismo espacio → exactamente una cita vigente y 19 rechazos; el
    índice único también rechaza una inserción directa de segunda cita vigente con el mismo inicio.
18. Búsqueda por correo: la 31.ª en una hora de la misma persona devuelve 429; las búsquedas quedan en el registro.

### Cancelar (historia 4)
19. Cancelar una cita futura: espacio libre en la siguiente consulta, correo `appointment_cancelled` encolado, quién y
    cuándo registrados.
20. Cancelar dos veces, una cita pasada o una de otro médico: 409, 409 y 404, sin repetir correos.
21. **Concurrencia**: cancelar y crear sobre el mismo espacio a la vez: queda como máximo una cita vigente; si se
    cancela una cita antes de enviarse su correo de agendada, ese correo no sale.

### Bloqueos (historia 5)
22. Bloquear un rango sin citas: sus espacios quedan bloqueados y no se pueden agendar.
23. Bloquear un rango con citas: 409 completo con la lista (fecha, hora, nombre), ningún espacio bloqueado, acción
    `block_rejected` registrada. Cancelar esas citas y repetir: se aplica.
24. Desbloquear libera los espacios; con dos bloqueos solapados, desbloquear uno no libera lo que otro cubre.
25. **Concurrencia**: bloquear y crear cita sobre el mismo horario a la vez, repetido muchas veces: nunca resultan ambos.
26. Rango que termina en el pasado, de más de 366 días o con fin ≤ inicio: rechazo. Un rango que empieza ayer y termina
    mañana con una cita de ayer: se acepta (solo cuentan citas con fin futuro).
27. Recepción bloquea y desbloquea con las mismas reglas; la acción queda a su nombre.

### Seguridad y aislamiento
28. Para cada ruta de agenda, cita y bloqueo: médico ajeno → 404; sin sesión → 401; rol no permitido → 403; sin CSRF → 403.
29. Los registros técnicos de las pruebas no contienen nombres, correos ni teléfonos.
30. `calendar_action_log` rechaza `UPDATE` y `DELETE`.
31. Consulta de agenda con 300 citas en la semana: responde en menos de 2 s.

## Validación manual (con un humano)

- Recorrer en el navegador: configurar → crear cita → cancelar → bloquear con conflicto → cancelar → bloquear →
  desbloquear, con SMTP real para ver los dos correos. Se anota en `tasks.md` como último paso, igual que la T123
  de la feature 1.
- En el entorno de despliegue (Hostinger): comprobar que MariaDB acepta la columna generada indexada de `appointment` y los
  disparadores de `calendar_action_log`; repetir los escenarios 17, 21 y 25 contra MariaDB.
