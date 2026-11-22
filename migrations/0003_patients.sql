-- 0003_patients: cuenta global del paciente, pacientes (propio y adicionales) y relación médico-paciente.
-- Sin campos de historial clínico ni de triaje (principio I de la constitución).

CREATE TABLE patient_account (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  phone VARCHAR(10) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_patient_account_user (user_id),
  CONSTRAINT fk_patient_account_user FOREIGN KEY (user_id) REFERENCES `user` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- birth_date es una fecha (no la edad); la edad se calcula al mostrarla.
CREATE TABLE patient (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  birth_date DATE NOT NULL,
  email VARCHAR(254) NULL,
  phone VARCHAR(10) NULL,
  is_minor_dependent TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_patient_account (account_id),
  CONSTRAINT fk_patient_account FOREIGN KEY (account_id) REFERENCES patient_account (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Unidad de aislamiento: un médico solo ve a los pacientes con los que tiene una fila aquí.
CREATE TABLE doctor_patient (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  patient_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_doctor_patient (doctor_id, patient_id),
  KEY idx_doctor_patient_patient (patient_id),
  CONSTRAINT fk_doctor_patient_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_doctor_patient_patient FOREIGN KEY (patient_id) REFERENCES patient (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- La aceptación en nombre de un menor apunta al paciente adicional.
ALTER TABLE consent_acceptance
  ADD CONSTRAINT fk_consent_on_behalf_patient FOREIGN KEY (on_behalf_of_patient_id) REFERENCES patient (id);
