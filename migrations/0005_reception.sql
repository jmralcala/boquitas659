-- 0005_reception: personal de recepción (hasta 2 personas por médico), invitaciones y registro de acciones.

-- Nombre de la persona de recepción (los demás roles guardan su nombre en su propia tabla).
ALTER TABLE `user` ADD COLUMN full_name VARCHAR(200) NULL;

CREATE TABLE reception_invitation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  email_normalized VARCHAR(254) NOT NULL,
  status ENUM('pending','accepted','expired','revoked') NOT NULL DEFAULT 'pending',
  invited_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  accepted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_reception_invitation_doctor (doctor_id, status),
  CONSTRAINT fk_reception_invitation_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_reception_invitation_user FOREIGN KEY (invited_by_user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- active_flag vale 1 mientras el vínculo está vigente y NULL al retirarlo: el índice único impide dos vínculos
-- vigentes iguales y permite volver a vincular a la misma persona después de retirarla.
CREATE TABLE reception_membership (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  reception_user_id BIGINT UNSIGNED NOT NULL,
  active_flag TINYINT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reception_membership_active (doctor_id, reception_user_id, active_flag),
  KEY idx_reception_membership_user (reception_user_id, active_flag),
  CONSTRAINT fk_reception_membership_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_reception_membership_user FOREIGN KEY (reception_user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quién hizo cada acción de recepción (y del médico sobre su recepción). Sin contenido, solo identificadores.
CREATE TABLE reception_action_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  target_type VARCHAR(40) NULL,
  target_id BIGINT UNSIGNED NULL,
  occurred_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_reception_action_doctor (doctor_id, occurred_at),
  KEY idx_reception_action_actor (actor_user_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE one_time_token
  ADD CONSTRAINT fk_one_time_token_invitation FOREIGN KEY (invitation_id) REFERENCES reception_invitation (id) ON DELETE CASCADE;
