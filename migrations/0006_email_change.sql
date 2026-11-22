-- 0006_email_change: el correo nuevo se verifica antes de pasar a ser el correo de acceso.
-- Mientras no se confirme, el correo nuevo vive en pending_email y el de acceso no cambia.

ALTER TABLE `user`
  ADD COLUMN pending_email VARCHAR(254) NULL,
  ADD COLUMN pending_email_normalized VARCHAR(254) NULL;

ALTER TABLE one_time_token
  MODIFY purpose ENUM('password_reset','reception_invite','email_change') NOT NULL;
