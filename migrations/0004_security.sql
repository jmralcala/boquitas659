-- 0004_security: dispositivos conocidos por usuario (aviso de inicio de sesión desde un dispositivo nuevo).
-- Solo se guarda un hash del identificador del dispositivo, ligado a la cuenta: el mismo identificador
-- produce hashes distintos para cuentas distintas.

CREATE TABLE trusted_device (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  device_hash CHAR(64) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_trusted_device (user_id, device_hash),
  CONSTRAINT fk_trusted_device_user FOREIGN KEY (user_id) REFERENCES `user` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
