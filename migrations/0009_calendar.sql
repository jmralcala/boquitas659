-- 0009_calendar: calendario del médico (configuración, horario semanal), citas, bloqueos y registro de acciones.
-- Compatible con MySQL 8 y MariaDB. Horas en UTC (DATETIME(3)). Sin campos clínicos ni de triaje (principio I).
-- Los espacios NO se guardan: se calculan al leer a partir de la configuración (ver specs/002-calendario-del-medico).

-- Una fila por médico; si no existe rigen los valores por defecto (se crea al primer guardado).
CREATE TABLE calendar_settings (
  doctor_id BIGINT UNSIGNED NOT NULL,
  slot_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 45,
  gap_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Mexico_City',
  min_notice_minutes INT UNSIGNED NOT NULL DEFAULT 120,
  max_advance_days SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (doctor_id),
  CONSTRAINT fk_calendar_settings_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT ck_calendar_slot CHECK (slot_minutes BETWEEN 15 AND 180 AND slot_minutes % 5 = 0),
  CONSTRAINT ck_calendar_gap CHECK (gap_minutes BETWEEN 0 AND 60 AND gap_minutes % 5 = 0),
  CONSTRAINT ck_calendar_notice CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  CONSTRAINT ck_calendar_advance CHECK (max_advance_days BETWEEN 1 AND 365),
  CONSTRAINT ck_calendar_notice_lt_advance CHECK (min_notice_minutes < max_advance_days * 1440)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Franjas del horario semanal en hora LOCAL del consultorio (minutos desde las 00:00). Se reemplazan todas al guardar.
CREATE TABLE calendar_hours (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  start_minute SMALLINT UNSIGNED NOT NULL,
  end_minute SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY idx_calendar_hours_doctor (doctor_id, weekday, start_minute),
  CONSTRAINT fk_calendar_hours_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT ck_calendar_hours_weekday CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT ck_calendar_hours_start CHECK (start_minute <= 1435 AND start_minute % 5 = 0),
  CONSTRAINT ck_calendar_hours_end CHECK (end_minute BETWEEN 5 AND 1440 AND end_minute % 5 = 0 AND end_minute > start_minute)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Citas. `active_start_utc` solo tiene valor mientras la cita está vigente: el índice único evita dos citas vigentes
-- con el mismo inicio para un médico (respaldo de la transacción con bloqueo; las canceladas no estorban: NULL no choca).
CREATE TABLE appointment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  patient_id BIGINT UNSIGNED NOT NULL,
  start_utc DATETIME(3) NOT NULL,
  end_utc DATETIME(3) NOT NULL,
  status ENUM('booked','cancelled') NOT NULL DEFAULT 'booked',
  kind ENUM('regular') NOT NULL DEFAULT 'regular',
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_by_role ENUM('doctor','reception') NOT NULL,
  created_at DATETIME(3) NOT NULL,
  cancelled_by_user_id BIGINT UNSIGNED NULL,
  cancelled_by_role ENUM('doctor','reception') NULL,
  cancelled_at DATETIME(3) NULL,
  active_start_utc DATETIME(3) GENERATED ALWAYS AS (IF(status = 'booked', start_utc, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_appointment_active_start (doctor_id, active_start_utc),
  KEY idx_appointment_doctor_start (doctor_id, start_utc),
  KEY idx_appointment_patient (patient_id),
  CONSTRAINT fk_appointment_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_appointment_patient FOREIGN KEY (patient_id) REFERENCES patient (id),
  CONSTRAINT fk_appointment_created_by FOREIGN KEY (created_by_user_id) REFERENCES `user` (id),
  CONSTRAINT fk_appointment_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES `user` (id),
  CONSTRAINT ck_appointment_range CHECK (end_utc > start_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bloqueos de horario: rango semiabierto [inicio, fin). Desbloquear borra la fila (la constancia queda en el registro).
CREATE TABLE calendar_block (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  start_utc DATETIME(3) NOT NULL,
  end_utc DATETIME(3) NOT NULL,
  reason VARCHAR(200) NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_by_role ENUM('doctor','reception') NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_calendar_block_range (doctor_id, start_utc, end_utc),
  CONSTRAINT fk_calendar_block_doctor FOREIGN KEY (doctor_id) REFERENCES doctor (id),
  CONSTRAINT fk_calendar_block_created_by FOREIGN KEY (created_by_user_id) REFERENCES `user` (id),
  CONSTRAINT ck_calendar_block_range CHECK (end_utc > start_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quién hizo qué sobre la agenda. SIN nombres, correos ni contenido. appointment_id y block_id no tienen clave foránea
-- a propósito: el registro es independiente de los datos (el bloqueo puede haberse borrado).
CREATE TABLE calendar_action_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  actor_role ENUM('doctor','reception') NOT NULL,
  action ENUM('settings_updated','appointment_created','appointment_cancelled','block_created','block_removed','block_rejected','patient_lookup') NOT NULL,
  appointment_id BIGINT UNSIGNED NULL,
  block_id BIGINT UNSIGNED NULL,
  outcome ENUM('ok','rejected') NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_calendar_log_doctor (doctor_id, occurred_at),
  KEY idx_calendar_log_actor (actor_user_id, action, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro de solo anexar: ni UPDATE ni DELETE (disparadores de una sola sentencia, sin BEGIN/END).
CREATE TRIGGER calendar_action_log_no_update BEFORE UPDATE ON calendar_action_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'calendar_action_log es de solo anexar';

CREATE TRIGGER calendar_action_log_no_delete BEFORE DELETE ON calendar_action_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'calendar_action_log es de solo anexar';
