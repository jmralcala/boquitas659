import { loadDotenvIfPresent } from "./config/dotenv.js";
import { loadEnv } from "./config/env.js";
import { createServer } from "./compose.js";

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
