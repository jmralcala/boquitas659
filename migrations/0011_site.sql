-- 0011_site: micrositio del médico, reserva del paciente, autorización de datos y revocación de vínculos.
-- Compatible con MySQL 8 y MariaDB. Horas en UTC (DATETIME(3)). Sin campos clínicos ni de triaje (principio I).

-- Una fila por médico, creada cuando elige el nombre de su enlace. El nombre es único por el índice (el primero que lo
-- registra se queda con él, también con peticiones simultáneas); solo soporte lo cambia.
CREATE TABLE doctor_site (
  doctor_id BIGINT UNSIGNED NOT NULL,
  slug VARCHAR(40) NOT NULL,
  address VARCHAR(300) NULL,
  logo_file VARCHAR(64) NULL,
  status ENUM('draft','published','unpublished') NOT NULL DEFAULT 'draft',
  first_published_at DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (doctor_id),
  UNIQUE KEY uq_doctor_site_slug (slug),
  CONSTRAINT fk_doctor_site_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT ck_doctor_site_slug_length CHECK (CHAR_LENGTH(slug) BETWEEN 3 AND 40)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Autorización de compartir los datos de contacto de la cuenta con un consultorio (solo anexar). La unidad de
-- consentimiento es la cuenta; queda la versión del aviso de privacidad vigente al autorizar.
CREATE TABLE data_authorization (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  given_by_user_id BIGINT UNSIGNED NOT NULL,
  legal_document_id BIGINT UNSIGNED NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_data_authorization_account (account_id, doctor_id, accepted_at),
  CONSTRAINT fk_data_authorization_account FOREIGN KEY (account_id) REFERENCES patient_account (id),
  CONSTRAINT fk_data_authorization_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_data_authorization_user FOREIGN KEY (given_by_user_id) REFERENCES `user` (id),
  CONSTRAINT fk_data_authorization_document FOREIGN KEY (legal_document_id) REFERENCES legal_document (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro de solo anexar: ni UPDATE ni DELETE (disparadores de una sola sentencia, sin BEGIN/END).
CREATE TRIGGER data_authorization_no_update BEFORE UPDATE ON data_authorization
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'data_authorization es de solo anexar';

CREATE TRIGGER data_authorization_no_delete BEFORE DELETE ON data_authorization
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'data_authorization es de solo anexar';

-- Vínculo médico-paciente: quién lo creó y si el paciente lo revocó (el consultorio deja de ver su contacto, pero
-- conserva el nombre en las citas pasadas). Los vínculos existentes los creó el personal.
ALTER TABLE doctor_patient
  ADD COLUMN origin ENUM('patient','office') NOT NULL DEFAULT 'office',
  ADD COLUMN created_by_user_id BIGINT UNSIGNED NULL,
  ADD COLUMN revoked_at DATETIME(3) NULL,
  ADD CONSTRAINT fk_doctor_patient_created_by FOREIGN KEY (created_by_user_id) REFERENCES `user` (id);

-- Límite de cancelación del paciente, por médico (horas; 24 por defecto).
ALTER TABLE calendar_settings
  ADD COLUMN cancel_notice_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24,
  ADD CONSTRAINT ck_calendar_cancel_notice CHECK (cancel_notice_hours BETWEEN 0 AND 168);

-- Citas creadas o canceladas por el paciente; marca del recordatorio ya encolado (a lo sumo uno por cita).
ALTER TABLE appointment
  MODIFY created_by_role ENUM('doctor','reception','patient') NOT NULL,
  MODIFY cancelled_by_role ENUM('doctor','reception','patient') NULL,
  ADD COLUMN reminder_enqueued_at DATETIME(3) NULL,
  ADD KEY idx_appointment_reminder (status, reminder_enqueued_at, start_utc);

-- Registro de acciones: el paciente también actúa y hay acciones nuevas.
ALTER TABLE calendar_action_log
  MODIFY actor_role ENUM('doctor','reception','patient') NOT NULL,
  MODIFY action ENUM('settings_updated','appointment_created','appointment_cancelled','block_created','block_removed','block_rejected','patient_lookup','site_updated','data_authorized','link_revoked') NOT NULL;

-- Tokens de los enlaces de correo: ligados a una cita, uno por propósito.
ALTER TABLE one_time_token
  MODIFY purpose ENUM('password_reset','reception_invite','email_change','appointment_confirmation','appointment_reminder') NOT NULL,
  ADD COLUMN appointment_id BIGINT UNSIGNED NULL,
  ADD KEY idx_one_time_token_appointment (appointment_id, purpose),
  ADD CONSTRAINT fk_one_time_token_appointment FOREIGN KEY (appointment_id) REFERENCES appointment (id);
