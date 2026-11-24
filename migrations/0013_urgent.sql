-- 0013_urgent: urgencias y triaje (feature 4). Compatible con MySQL 8 y MariaDB.
-- Principio I: NO se guarda la categoría del triaje ni las señales de alarma; solo el tipo de cita. La categoría vive
-- únicamente en el payload de la cola de envío (email_outbox) y se borra al llegar a un estado final o a las 24 h.

-- Franjas de urgencia: son franjas del horario semanal con otro tipo. Las existentes quedan `regular`.
ALTER TABLE calendar_hours
  ADD COLUMN kind ENUM('regular','urgent') NOT NULL DEFAULT 'regular';

-- Anticipación mínima de una urgencia (30 minutos por defecto; 0 a 1440).
ALTER TABLE calendar_settings
  ADD COLUMN urgent_min_notice_minutes INT UNSIGNED NOT NULL DEFAULT 30,
  ADD CONSTRAINT ck_calendar_urgent_notice CHECK (urgent_min_notice_minutes BETWEEN 0 AND 1440);

-- Tipo de cita: es lo único que se conserva del triaje.
ALTER TABLE appointment
  MODIFY kind ENUM('regular','urgent') NOT NULL DEFAULT 'regular';

-- Registro de acciones: una fila por solicitud de urgencia (outcome `ok` = agendada, `rejected` = sin espacio), sin categoría.
-- El índice (actor_user_id, action, occurred_at) de 0009 ya cubre el conteo de 24 h por cuenta.
ALTER TABLE calendar_action_log
  MODIFY action ENUM('settings_updated','appointment_created','appointment_cancelled','block_created','block_removed','block_rejected','patient_lookup','site_updated','data_authorized','link_revoked','urgent_requested') NOT NULL;
