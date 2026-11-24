import { createInterface } from "node:readline/promises";
import { loadDotenvIfPresent } from "../src/config/dotenv.js";
import { loadEnv } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { AppError } from "../src/http/errors.js";
import { systemClock } from "../src/lib/clock.js";
import { changeSiteSlug } from "../src/modules/site/change-slug.js";

/**
 * Procedimiento de soporte: cambia el nombre del enlace de un micrositio (`/c/<nombre>`). Pide los datos, muestra el cambio y
 * exige escribir «si» para confirmar. El nombre anterior deja de funcionar: avisa al médico para que reparta el nuevo enlace.
 */
loadDotenvIfPresent();
const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

try {
  const supportEmail = (await rl.question("Tu correo de soporte: ")).trim();
  const currentSlug = (await rl.question("Nombre actual del enlace (lo que va después de /c/): ")).trim();
  const newSlug = (await rl.question("Nombre nuevo: ")).trim();
  const answer = (await rl.question(`Cambiar /c/${currentSlug} por /c/${newSlug}. El enlace anterior dejará de funcionar. Escribe «si» para confirmar: `)).trim().toLowerCase();
  if (answer !== "si" && answer !== "sí") {
    process.stdout.write("Cancelado: no se cambió nada.\n");
  } else {
    await changeSiteSlug(db, systemClock, { supportEmail, currentSlug, newSlug });
    process.stdout.write(`Listo: el micrositio ahora es /c/${newSlug}. La acción quedó en el registro de acciones.\n`);
  }
} catch (error) {
  if (error instanceof AppError) {
    const detail = error.fields ? Object.values(error.fields).flat().join(" ") : error.publicMessage;
    process.stderr.write(`No se pudo cambiar el nombre: ${detail}\n`);
  } else {
    // Solo tipo y código: el mensaje del servidor puede incluir datos.
    process.stderr.write(`Error inesperado (${(error as Error).name}, código ${(error as { code?: string }).code ?? "desconocido"}).\n`);
  }
  process.exitCode = 1;
} finally {
  rl.close();
  await db.end();
}
