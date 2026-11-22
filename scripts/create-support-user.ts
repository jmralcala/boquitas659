import { createInterface } from "node:readline/promises";
import { loadDotenvIfPresent } from "../src/config/dotenv.js";
import { loadEnv } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { AppError } from "../src/http/errors.js";
import { createPasswordHasher } from "../src/modules/auth/password-hasher.js";
import { createSupportUser } from "../src/modules/support/create-support-user.js";

/**
 * Lee una línea sin mostrarla en pantalla (contraseña). Con entrada redirigida (sin terminal) lee una línea normal.
 * La contraseña nunca se pasa por argumentos de línea de comandos (quedarían en el historial del shell).
 */
async function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const rl = createInterface({ input });
    const line = await rl.question("");
    rl.close();
    return line;
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
  });
}

loadDotenvIfPresent();
const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);

try {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const email = (await rl.question("Correo del usuario de soporte: ")).trim();
  rl.close();
  const password = await readHidden("Contraseña (mínimo 10 caracteres): ");

  const id = await createSupportUser(db, createPasswordHasher(env.PASSWORD_HASHER), { email, password });
  process.stdout.write(`Usuario de soporte creado (id ${id}). Configurará el doble factor en su primer acceso.\n`);
} catch (error) {
  if (error instanceof AppError) {
    const detail = error.fields ? Object.values(error.fields).flat().join(" ") : error.publicMessage;
    process.stderr.write(`No se pudo crear el usuario: ${detail}\n`);
  } else {
    // Solo tipo y código: el mensaje del servidor puede incluir datos.
    process.stderr.write(`Error inesperado (${(error as Error).name}, código ${(error as { code?: string }).code ?? "desconocido"}).\n`);
  }
  process.exitCode = 1;
} finally {
  await db.end();
}
