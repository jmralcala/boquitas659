import { loadDotenvIfPresent } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { runCleanup } from "./cleanup-service.js";

/** Tarea de cron (por ejemplo cada hora): borra tokens, sesiones, correos y contadores que ya no sirven. */
loadDotenvIfPresent();
const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);

try {
  const result = await runCleanup(db);
  process.stdout.write(
    `Limpieza: ${result.tokens} tokens, ${result.sessions} sesiones, ${result.emails} correos, ${result.throttle} contadores.\n`,
  );
} catch (error) {
  const code = (error as { code?: string }).code ?? "desconocido";
  process.stderr.write(`Error en la limpieza (${(error as Error).name}, código ${code}).\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
