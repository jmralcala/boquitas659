import { parseArgs } from "node:util";
import { loadDotenvIfPresent } from "../src/config/dotenv.js";
import { loadEnv } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { DELIVERY_TARGET_PERCENT, deliveryReport } from "../src/mail/delivery-report.js";

/**
 * Informe de entrega de correos para la meta del piloto (SC-010: más de 98 % entregados).
 * Uso: npm run report:email [-- --days 30]
 * Solo imprime conteos por plantilla: ni direcciones ni contenido.
 */
let days = 30;
try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { days: { type: "string" } }, strict: true });
  if (values.days !== undefined) {
    days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days debe ser un entero entre 1 y 365.");
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

loadDotenvIfPresent();
const env = loadEnv();
const db = createPool(env.DATABASE_URL, 2);

try {
  const to = new Date();
  const report = await deliveryReport(db, { from: new Date(to.getTime() - days * 86_400_000), to });
  const lines = [
    `Correos de los últimos ${days} días: ${report.sent} entregados, ${report.failed} fallidos, ${report.queued} pendientes.`,
    report.deliveredPercent === null
      ? "Todavía no hay correos resueltos para calcular el porcentaje."
      : `Entregados: ${report.deliveredPercent} % (meta: más de ${DELIVERY_TARGET_PERCENT} %) → ${report.meetsTarget ? "CUMPLE" : "NO CUMPLE"}.`,
    "",
    ...report.byTemplate.map((t) => `  ${t.template}: ${t.sent} entregados, ${t.failed} fallidos, ${t.queued} pendientes`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  const code = (error as { code?: string }).code ?? "desconocido";
  process.stderr.write(`Error al generar el informe (${(error as Error).name}, código ${code}).\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
