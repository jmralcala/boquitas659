import { existsSync } from "node:fs";

/**
 * Carga `.env` (ignorado por git) en desarrollo. En el hosting las variables vienen del panel,
 * así que si el archivo no existe no pasa nada. Las variables ya definidas tienen prioridad.
 */
export function loadDotenvIfPresent(path = ".env"): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
