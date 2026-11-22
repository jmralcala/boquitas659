-- 0008_outbox_cancelled: un correo en cola puede cancelarse si deja de tener sentido antes de enviarse
-- (por ejemplo, la invitación se revocó o se pidió otro cambio de correo). No cuenta como fallo de entrega.

ALTER TABLE email_outbox
  MODIFY status ENUM('queued','sent','failed','cancelled') NOT NULL DEFAULT 'queued';
