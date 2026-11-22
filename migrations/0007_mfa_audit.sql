-- 0007_mfa_audit: doble factor (TOTP) y registro de accesos al detalle de pacientes.

-- Último paso de tiempo TOTP aceptado: impide reutilizar un código (replay).
ALTER TABLE `user` ADD COLUMN mfa_last_time_step BIGINT NULL;

-- Códigos de recuperación: solo se guarda un HMAC (con la clave de la aplicación), nunca el código; un solo uso.
CREATE TABLE mfa_recovery_code (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mfa_recovery_code (user_id, code_hash),
  CONSTRAINT fk_mfa_recovery_code_user FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quién abrió el detalle de qué paciente, en nombre de qué médico, con qué resultado y cuándo. SIN contenido del
-- paciente. patient_id no tiene clave foránea a propósito: también se registran los intentos sobre ids inexistentes.
CREATE TABLE patient_access_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  actor_role ENUM('doctor','reception') NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  patient_id BIGINT UNSIGNED NOT NULL,
  outcome ENUM('allowed','denied') NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_patient_access_patient (patient_id, occurred_at),
  KEY idx_patient_access_actor (actor_user_id, occurred_at),
  KEY idx_patient_access_doctor (doctor_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro de solo anexar: ni UPDATE ni DELETE (disparadores de una sola sentencia, sin BEGIN/END).
CREATE TRIGGER patient_access_log_no_update BEFORE UPDATE ON patient_access_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_access_log es de solo anexar';

CREATE TRIGGER patient_access_log_no_delete BEFORE DELETE ON patient_access_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_access_log es de solo anexar';
