-- 0010_calendar_log_retention: el registro de acciones de la agenda se conserva 90 días.
-- Sigue siendo de solo anexar: UPDATE se rechaza siempre y DELETE solo se permite para filas de más de 90 días
-- (la tarea de limpieza periódica borra solo esas). Cualquier intento de borrar filas recientes se rechaza.
-- El cuerpo es una sola sentencia de control de flujo (sin BEGIN/END), como el resto de los disparadores.

DROP TRIGGER calendar_action_log_no_delete;

CREATE TRIGGER calendar_action_log_no_delete BEFORE DELETE ON calendar_action_log
  FOR EACH ROW IF OLD.occurred_at > (UTC_TIMESTAMP(3) - INTERVAL 90 DAY) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'calendar_action_log es de solo anexar (solo se borra lo de más de 90 días)'; END IF;
