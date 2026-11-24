-- Soporte puede cambiar el nombre del enlace de un micrositio (scripts/change-site-slug.ts) y la acción queda en el
-- registro de la agenda con su rol. Solo amplía el catálogo de roles: no toca filas ni disparadores.
ALTER TABLE calendar_action_log
  MODIFY actor_role ENUM('doctor','reception','patient','support') NOT NULL;
