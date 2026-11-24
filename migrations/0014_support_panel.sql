-- 0014_support_panel: panel de soporte (feature 5). Compatible con MySQL 8 y MariaDB.
-- Principio I: nada de esto guarda datos de pacientes ni la categoría del triaje. Las métricas son contadores agregados.

-- Estado operativo de la cuenta del médico, independiente de la aprobación de su cédula.
ALTER TABLE doctor
  ADD COLUMN account_state ENUM('active','suspended','read_only') NOT NULL DEFAULT 'active',
  ADD COLUMN account_state_changed_at DATETIME(3) NULL,
  ADD COLUMN account_state_changed_by BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_doctor_state_changed_by FOREIGN KEY (account_state_changed_by) REFERENCES `user` (id);

-- Motivo genérico del último fallo de envío: un código cerrado, nunca texto del servidor.
ALTER TABLE email_outbox
  ADD COLUMN last_error_code VARCHAR(40) NULL;

-- Historial de acciones de soporte: de solo anexar (disparadores de una sola sentencia, como calendar_action_log).
CREATE TABLE support_action_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  support_user_id BIGINT UNSIGNED NOT NULL,
  action ENUM('approve','reject','release_cedula','suspend','read_only','reactivate','change_slug','retry_email','cancel_email','view_cedula') NOT NULL,
  target_type ENUM('doctor','site','email') NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NULL,
  occurred_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_support_log_time (occurred_at, id),
  KEY idx_support_log_actor (support_user_id, occurred_at),
  KEY idx_support_log_action (action, occurred_at),
  CONSTRAINT fk_support_log_user FOREIGN KEY (support_user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER support_action_log_no_update BEFORE UPDATE ON support_action_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'support_action_log es de solo anexar';

CREATE TRIGGER support_action_log_no_delete BEFORE DELETE ON support_action_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'support_action_log es de solo anexar';

-- Las decisiones anteriores de soporte pasan al historial (doctor_review se conserva: lo lee el reenvío de la cédula).
INSERT INTO support_action_log (support_user_id, action, target_type, target_id, reason, occurred_at)
SELECT decided_by_user_id,
       CASE decision WHEN 'approved' THEN 'approve' WHEN 'rejected' THEN 'reject' ELSE 'release_cedula' END,
       'doctor', doctor_id, reason, decided_at
  FROM doctor_review
 ORDER BY decided_at, id;

-- Nombre de enlace que fue de un consultorio y no puede reasignarse a otro mientras dure la reserva (90 días).
CREATE TABLE site_slug_reservation (
  slug VARCHAR(40) NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  reserved_until DATETIME(3) NOT NULL,
  PRIMARY KEY (slug),
  KEY idx_slug_reservation_doctor (doctor_id),
  CONSTRAINT fk_slug_reservation_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Contadores diarios del piloto por médico. Sin identificadores de persona, de sesión ni de IP.
CREATE TABLE pilot_metric_daily (
  day DATE NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  started INT UNSIGNED NOT NULL DEFAULT 0,
  completed INT UNSIGNED NOT NULL DEFAULT 0,
  duration_sum_seconds BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration_count INT UNSIGNED NOT NULL DEFAULT 0,
  under_target_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, doctor_id),
  KEY idx_pilot_metric_doctor (doctor_id, day),
  CONSTRAINT fk_pilot_metric_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
