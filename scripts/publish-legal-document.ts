import { readFileSync } from "node:fs";
import { loadDotenvIfPresent } from "../src/config/dotenv.js";
import { loadEnv } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createLegalService } from "../src/modules/legal/legal-service.js";
import { parsePublishArgs } from "../src/modules/legal/publish-args.js";
import { DEFAULT_TITLES } from "../src/modules/legal/seed-provisional.js";

/**
 * Publica una versión nueva de un documento legal desde un archivo de texto.
 * Uso: npm run legal:publish -- --type patient_privacy --file aviso.txt [--title "..."] [--reviewed]
 * Sin --reviewed queda como provisional. Las personas afectadas deberán aceptar la nueva versión al volver a entrar.
 */
let args;
try {
  args = parsePublishArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

loadDotenvIfPresent();
const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);

try {
  const body = readFileSync(args.file, "utf8").trim();
  if (body.length === 0) throw new Error("El archivo está vacío.");
  const legal = createLegalService(db);
  const title = args.title ?? (await legal.latest(args.type))?.title ?? DEFAULT_TITLES[args.type];
  const document = await legal.publish({ type: args.type, title, body, isProvisional: args.isProvisional });
  process.stdout.write(
    `Publicado: ${document.type} versión ${document.version} (${document.isProvisional ? "provisional" : "revisado"}).\n`,
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  process.stderr.write(`No se pudo publicar: ${code ? `código ${code}` : (error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
