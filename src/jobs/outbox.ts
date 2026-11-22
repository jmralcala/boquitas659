import { loadDotenvIfPresent } from "../config/dotenv.js";
import { loadEnv } from "../config/env.js";
import { createPool } from "../db/pool.js";
import { processOutbox } from "../mail/outbox.js";
import { defaultTemplates } from "../mail/templates.js";
import { createMemoryTransport, createSmtpTransport, type MailTransport } from "../mail/transport.js";
import { createOneTimeTokenService } from "../modules/auth/one-time-tokens.js";

/** Tarea de cron (cada minuto): envía los correos pendientes. Es idempotente y segura si se solapa. */
loadDotenvIfPresent();
const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);

let transport: MailTransport;
if (env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM) {
  transport = createSmtpTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
  });
} else {
  // Solo se llega aquí en desarrollo (en producción el SMTP es obligatorio): los correos no salen.
  process.stdout.write("SMTP no configurado: se usa un transporte en memoria, los correos no se envían.\n");
  transport = createMemoryTransport();
}

try {
  const result = await processOutbox({
    db,
    transport,
    tokens: createOneTimeTokenService(db),
    templates: defaultTemplates,
    baseUrl: env.PUBLIC_BASE_URL,
    log: (event) => process.stderr.write(`${JSON.stringify({ component: "outbox", ...event })}\n`),
  });
  process.stdout.write(`Outbox: ${result.sent} enviados, ${result.retried} reintentos, ${result.failed} fallidos, ${result.cancelled} cancelados.\n`);
} catch (error) {
  const code = (error as { code?: string }).code ?? "desconocido";
  process.stderr.write(`Error en el outbox (${(error as Error).name}, código ${code}).\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
