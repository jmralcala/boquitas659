-- 0002_doctors: médicos, estado de aprobación y decisiones de soporte.
-- Cédula y móvil de emergencias: únicos mientras no estén liberados (NULL al liberarlos; varios NULL están permitidos).

CREATE TABLE doctor (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  cedula_number VARCHAR(20) NULL,
  cedula_normalized VARCHAR(20) NULL,
  cedula_file_path VARCHAR(255) NULL,
  cedula_file_sha256 CHAR(64) NULL,
  emergency_mobile VARCHAR(10) NULL,
  office_phone VARCHAR(10) NULL,
  approval_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(500) NULL,
  approved_at DATETIME(3) NULL,
  approved_by_user_id BIGINT UNSIGNED NULL,
  trial_started_at DATETIME(3) NULL,
  trial_ends_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_doctor_user (user_id),
  UNIQUE KEY uq_doctor_cedula (cedula_normalized),
  UNIQUE KEY uq_doctor_mobile (emergency_mobile),
  KEY idx_doctor_status (approval_status, created_at),
  CONSTRAINT fk_doctor_user FOREIGN KEY (user_id) REFERENCES `user` (id),
  CONSTRAINT fk_doctor_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE doctor_review (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  decision ENUM('approved','rejected','cedula_released') NOT NULL,
  reason VARCHAR(500) NULL,
  decided_by_user_id BIGINT UNSIGNED NOT NULL,
  decided_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_doctor_review_doctor (doctor_id, decided_at),
  CONSTRAINT fk_doctor_review_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_doctor_review_user FOREIGN KEY (decided_by_user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE session
  ADD CONSTRAINT fk_session_active_doctor FOREIGN KEY (active_doctor_id) REFERENCES doctor (id) ON DELETE SET NULL;
