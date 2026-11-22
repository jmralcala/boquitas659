-- 0001_core: identidad, sesiones, tokens de un solo uso, correo, documentos legales y consentimientos.
-- Compatible con MySQL 8 y MariaDB. Horas en UTC (DATETIME(3)). Sin tipo JSON (MariaDB lo trata como texto).

CREATE TABLE `user` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  email_normalized VARCHAR(254) NOT NULL,
  role ENUM('patient','doctor','reception','support') NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_changed_at DATETIME(3) NOT NULL,
  mfa_enabled TINYINT(1) NOT NULL DEFAULT 0,
  mfa_secret_encrypted VARCHAR(512) NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_email_normalized (email_normalized)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE session (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  active_doctor_id BIGINT UNSIGNED NULL,
  mfa_verified TINYINT(1) NOT NULL DEFAULT 0,
  csrf_secret VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL,
  absolute_expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token_hash (token_hash),
  KEY idx_session_user (user_id),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE one_time_token (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64) NOT NULL,
  purpose ENUM('password_reset','reception_invite') NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  invitation_id BIGINT UNSIGNED NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_one_time_token_hash (token_hash),
  KEY idx_one_time_token_user (user_id, purpose),
  KEY idx_one_time_token_invitation (invitation_id, purpose),
  CONSTRAINT fk_one_time_token_user FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_throttle (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope ENUM('account','ip') NOT NULL,
  key_hash CHAR(64) NOT NULL,
  failures INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_login_throttle_key (scope, key_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE email_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template VARCHAR(64) NOT NULL,
  to_email VARCHAR(254) NOT NULL,
  payload_ref TEXT NOT NULL,
  status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  locked_until DATETIME(3) NULL,
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_email_outbox_due (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE legal_document (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('patient_privacy','doctor_privacy','reception_privacy','reception_confidentiality','terms_doctor') NOT NULL,
  version INT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  is_provisional TINYINT(1) NOT NULL DEFAULT 1,
  published_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_document_type_version (type, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consent_acceptance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  on_behalf_of_patient_id BIGINT UNSIGNED NULL,
  legal_document_id BIGINT UNSIGNED NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  ip_hash CHAR(64) NULL,
  PRIMARY KEY (id),
  KEY idx_consent_user (user_id),
  KEY idx_consent_document (legal_document_id),
  CONSTRAINT fk_consent_user FOREIGN KEY (user_id) REFERENCES `user` (id),
  CONSTRAINT fk_consent_document FOREIGN KEY (legal_document_id) REFERENCES legal_document (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro de solo anexar: ni UPDATE ni DELETE (los disparadores usan una sola sentencia, sin BEGIN/END).
CREATE TRIGGER consent_acceptance_no_update BEFORE UPDATE ON consent_acceptance
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consent_acceptance es de solo anexar';

CREATE TRIGGER consent_acceptance_no_delete BEFORE DELETE ON consent_acceptance
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consent_acceptance es de solo anexar';

CREATE TABLE security_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  type VARCHAR(64) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_security_event_user (user_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
