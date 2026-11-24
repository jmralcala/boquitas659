# Quickstart: validación del panel de soporte

Guía de validación de la feature 5. Cada escenario es una prueba automática (vitest) y, salvo el último bloque, se puede
repetir a mano con el servidor local.

## Prerrequisitos

- Base de pruebas MySQL 8 con las migraciones `0001`–`0014` aplicadas (`npm run migrate`).
- `TEST_DATABASE_URL` en `.env`. Una cuenta de soporte con doble factor verificado (factories de
  `tests/integration/helpers/`), un médico aprobado con micrositio publicado y horarios, un paciente con cita, y correos en
  cola, fallidos y enviados.
- Vitest por PowerShell con la ruta `C:\…`. Reloj fijo (`FixedClock`): fijarlo **antes** de abrir las sesiones.

## Comandos

```text
npm run lint · npm run typecheck · npm run test · npm run build
```

## Escenarios

### Acceso y auditoría
1. Médico, recepción y paciente reciben 403 en todas las rutas de `/soporte`; sin sesión, 401; soporte sin segundo factor activo,
   303 al alta.
2. Ninguna ruta del panel acepta cambiar una cuenta de soporte ni crea una sesión como otro usuario.
3. Un cambio sin motivo o sin `confirm` responde 400 y no cambia nada ni escribe historial.

### Ciclo de vida (historia 1)
4. Suspender un médico aprobado: no puede iniciar sesión, su sesión abierta deja de valer, su recepción recibe 403, su micrositio
   muestra «confirma por teléfono», se registra la acción y se encola el aviso fijo (sin motivo).
5. Reactivar: recupera acceso y el micrositio vuelve a su estado anterior.
6. Solo lectura: el médico y su recepción pueden `GET` y reciben 403 en cualquier `POST`; el micrositio no acepta reservas ni
   urgencias; un paciente **sí** cancela su cita.
7. Transiciones inválidas (reactivar a quien está activo, suspender a un pendiente) → 409 sin cambios ni historial duplicado.
8. Concurrencia: dos acciones de soporte simultáneas sobre la misma cuenta (más 20 reservas y una urgencia entrantes) terminan
   con un único estado válido, una sola entrada de historial por acción y sin reservas a medias.
9. Aprobar una cuenta no la deja en solo lectura ni la suspende por tiempo de prueba (FR-011).

### Micrositios y correos (historia 2)
10. La lista de micrositios cuenta borradores, publicados y despublicados y filtra por estado.
11. Cambiar el enlace: el nuevo funciona, el anterior da 404, queda reservado 90 días para su dueño; un nombre en uso o reservado
    por otro médico → 409; queda `change_slug` y el aviso al médico.
12. La vista de correos muestra conteos, antigüedad y fallidos con tipo, intentos y código; **ninguna respuesta contiene
    `payload`, asunto, cuerpo, destinatario completo ni categoría** (HTML y JSON).
13. Reintentar un fallido de un tipo reintentable lo vuelve a `queued`; el aviso de urgencia fallido no ofrece acción y devuelve 409.
14. Cancelar un correo en cola o fallido lo deja `cancelled` y se registra.

### Métricas (historia 3)
15. Con datos conocidos (aperturas y reservas de formulario, correos enviados y fallidos, urgencias agendadas y sin espacio,
    citas por semana), cada cifra coincide con el cálculo manual y con su meta.
16. Periodo sin datos: «sin datos», no cero ni error. Sin nombres, correos, teléfonos ni categoría en la pantalla.
17. Una apertura con firma inválida o de más de 60 minutos cuenta como `completed` pero no entra en la duración.

### Historial (historia 4)
18. Dos personas de soporte realizan acciones; el historial las lista con autor y motivo, más recientes primero, con paginación
    y filtros por persona, acción y fechas.
19. Abrir la cédula registra `view_cedula`. Un `UPDATE` o `DELETE` directo sobre `support_action_log` falla.
20. Las decisiones anteriores de `doctor_review` aparecen en el historial tras la migración.

### Liberar cédula (historia 5)
21. La pantalla previa muestra el número de citas futuras y el estado del micrositio sin cambiar nada; confirmar libera la
    cédula, otra persona puede registrarla y el médico queda sin acceso con aviso fijo.

### Privacidad (transversal)
22. Prueba estática: el módulo `src/modules/support/` no referencia las tablas de pacientes ni selecciona `payload_ref`
    (lista justificada de excepciones: `COUNT` de citas por médico).
23. Ningún registro técnico del panel contiene categoría de urgencia ni contenido de mensajes.
24. `route-audit` incluye las rutas de soporte (roles y ausencia de datos de pacientes).

## Validación manual (T-final, por una persona)

- Navegador: recorrer cada pantalla con una cuenta de soporte real y doble factor.
- SMTP real: los cuatro avisos de estado llegan y no revelan el motivo.
- MariaDB de Hostinger: aplicar `0014` y repetir los escenarios 4, 8 y 12.
- Piloto: comparar las métricas del tablero con un conteo manual de la primera semana.
