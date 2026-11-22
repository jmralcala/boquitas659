import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadDotenvIfPresent } from "../config/dotenv.js";
import { runMigrations } from "./migrate.js";

loadDotenvIfPresent();

const parsed = z.object({ DATABASE_URL: z.string().min(1) }).safeParse(process.env);
if (!parsed.success) {
  process.stderr.write("Falta la variable DATABASE_URL.\n");
  process.exit(1);
}

// Compilado queda en dist/src/db; las migraciones viven en la raíz del repositorio.
const directory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

try {
  const { applied } = await runMigrations(parsed.data.DATABASE_URL, directory);
  process.stdout.write(
    applied.length > 0 ? `Migraciones aplicadas: ${applied.join(", ")}\n` : "Sin migraciones pendientes.\n",
  );
} catch (error) {
  // Se imprime solo el tipo y el código; el mensaje del servidor puede incluir datos.
  const code = (error as { code?: string }).code ?? "desconocido";
  process.stderr.write(`Error al migrar (${(error as Error).name}, código ${code}).\n`);
  process.exit(1);
}
