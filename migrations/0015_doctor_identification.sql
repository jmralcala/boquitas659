-- Identificación oficial del médico: soporte la coteja a mano con la cédula antes de aprobar (evita la usurpación de identidad
-- y protege al paciente). Nulas para las cuentas anteriores; el alta y el reenvío de solicitudes nuevas la exigen.
ALTER TABLE doctor
  ADD COLUMN id_file_path VARCHAR(255) NULL AFTER cedula_file_sha256,
  ADD COLUMN id_file_sha256 CHAR(64) NULL AFTER id_file_path;

-- La consulta del archivo de identificación también se audita.
ALTER TABLE support_action_log
  MODIFY COLUMN action ENUM('approve','reject','release_cedula','suspend','read_only','reactivate','change_slug','retry_email','cancel_email','view_cedula','view_identificacion') NOT NULL;
