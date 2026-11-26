import { loadDotenvIfPresent } from "./config/dotenv.js";
import { loadEnv } from "./config/env.js";
import { createServer } from "./compose.js";

/**
 * Sin `await` de nivel superior a propósito: el hosting (LiteSpeed) carga el archivo de entrada con `require()`,
 * y Node rechaza con ERR_REQUIRE_ASYNC_MODULE un módulo ESM que lo use.
 */
async function main(): Promise<void> {
  loadDotenvIfPresent();
  const env = loadEnv();
  const server = await createServer(env);

  async function shutdown(): Promise<void> {
    await server.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await server.app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  // Solo el tipo y el mensaje (el de la configuración lista nombres de variables, nunca valores).
  process.stderr.write(`No se pudo iniciar el servidor: ${error instanceof Error ? error.message : "error desconocido"}\n`);
  process.exit(1);
});
