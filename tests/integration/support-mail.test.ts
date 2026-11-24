import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../src/http/errors.js";
import { processOutbox } from "../../src/mail/outbox.js";
import type { MailTransport } from "../../src/mail/transport.js";
import { clearTables, createEmail, createTestPool, ensurePrivacyDocument, resetDatabase } from "./helpers/db.js";
import { createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let supportId: number;
let client: AuthedClient;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
  const support = await createSupportWithMfa(t, pool);
  supportId = support.id;
  client = await sessionFor(t.services, support);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const SECRET_CATEGORY = "naranja";
const get = (url: string, accept = "text/html") => t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept } });

describe("resumen de la cola de correos", () => {
  it("cuenta por estado, da la antigüedad del pendiente más viejo y lista los fallidos con lo mínimo", async () => {
    const old = new Date("2026-06-10T10:00:00.000Z");
    await createEmail(pool, { status: "queued", createdAt: old });
    await createEmail(pool, { status: "queued", createdAt: new Date("2026-06-14T10:00:00.000Z") });
    await createEmail(pool, { status: "sent" });
    await createEmail(pool, { status: "cancelled" });
    const failedId = await createEmail(pool, { status: "failed", attempts: 3, lastErrorCode: "smtp_timeout", to: "ana.garcia@clinica.example.com" });

    const summary = await t.services.mailQueue.summary(1);
    expect(summary.counts).toEqual({ queued: 2, sent: 1, failed: 1, cancelled: 1 });
    expect(summary.oldestQueuedAt?.toISOString()).toBe(old.toISOString());
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ id: failedId, template: "appointment_created", attempts: 3, errorCode: "smtp_timeout", maskedTo: "a***@clinica.example.com" });
    expect(Object.keys(summary.failed[0] ?? {}).sort()).toEqual(["attempts", "createdAt", "errorCode", "id", "maskedTo", "retryable", "template"]);
  });

  it("sin pendientes la antigüedad es nula", async () => {
    await createEmail(pool, { status: "sent" });
    expect((await t.services.mailQueue.summary(1)).oldestQueuedAt).toBeNull();
  });

  it("con 200 correos fallidos pagina de 50 en 50 y responde", async () => {
    for (let index = 0; index < 200; index += 1) await createEmail(pool, { status: "failed", attempts: 6, lastErrorCode: "other" });
    const first = await t.services.mailQueue.summary(1);
    expect(first.failed).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    expect((await t.services.mailQueue.summary(4)).hasNext).toBe(false);
    expect((await get("/soporte/correos?pagina=2")).statusCode).toBe(200);
  });
});

describe("la vista nunca muestra contenido, destinatario completo ni categoría", () => {
  it("ni el HTML ni el JSON contienen payload, asunto, cuerpo, correo completo o la categoría de un aviso de urgencia fallido", async () => {
    await createEmail(pool, { status: "failed", template: "doctor_urgent_notice", lastErrorCode: "smtp_rejected", to: "medico.privado@clinica.example.com", payload: { appointmentId: 77, category: SECRET_CATEGORY } });
    await createEmail(pool, { status: "failed", template: "appointment_created", lastErrorCode: "other", to: "paciente.visible@example.com", payload: { appointmentId: 78, texto: "CONTENIDO-DEL-MENSAJE" } });
    await createEmail(pool, { status: "queued", template: "doctor_urgent_notice", to: "otro.medico@example.com", payload: { appointmentId: 79, category: SECRET_CATEGORY } });

    for (const [url, accept] of [["/soporte/correos", "text/html"], ["/soporte/correos", "application/json"]] as const) {
      const body = (await get(url, accept)).body;
      expect(body, accept).not.toContain(SECRET_CATEGORY);
      expect(body, accept).not.toContain("CONTENIDO-DEL-MENSAJE");
      expect(body, accept).not.toContain("payload");
      expect(body, accept).not.toContain("appointmentId");
      expect(body, accept).not.toContain("medico.privado@clinica.example.com");
      expect(body, accept).not.toContain("paciente.visible@example.com");
      expect(body, accept).toContain("m***@clinica.example.com");
    }
  });

  it("la consulta del servicio nunca lee payload_ref", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync("src/modules/support/mail-queue-service.ts", "utf8"));
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")).not.toContain("payload_ref");
  });
});

describe("reintentar y cancelar", () => {
  it("reintentar un fallido reintentable lo devuelve a la cola con cero intentos y deja historial", async () => {
    const id = await createEmail(pool, { status: "failed", attempts: 6, lastErrorCode: "smtp_unreachable" });
    await t.services.mailQueue.retry({ emailId: id, supportUserId: supportId, reason: "el SMTP ya volvió" });
    const [row] = await rows("SELECT status, attempts, next_attempt_at, last_error_code FROM email_outbox WHERE id = ?", [id]);
    expect(row).toMatchObject({ status: "queued", attempts: 0, last_error_code: null });
    expect((row?.next_attempt_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await rows("SELECT action, target_type, target_id, reason FROM support_action_log")).toEqual([
      { action: "retry_email", target_type: "email", target_id: id, reason: "el SMTP ya volvió" },
    ]);
  });

  it("el aviso de urgencia fallido y los estados que no son fallido responden 409 sin cambios", async () => {
    const urgent = await createEmail(pool, { status: "failed", template: "doctor_urgent_notice", payload: { appointmentId: 1 } });
    const sent = await createEmail(pool, { status: "sent" });
    const queuedUrgent = await createEmail(pool, { status: "queued", template: "doctor_urgent_notice", payload: { appointmentId: 1, category: SECRET_CATEGORY } });
    for (const emailId of [urgent, sent]) {
      await expect(t.services.mailQueue.retry({ emailId, supportUserId: supportId, reason: "x" })).rejects.toBeInstanceOf(ConflictError);
    }
    // Un aviso de urgencia en cola tampoco se cancela desde el panel: la cola lo gestiona sola.
    await expect(t.services.mailQueue.cancel({ emailId: queuedUrgent, supportUserId: supportId, reason: "x" })).rejects.toBeInstanceOf(ConflictError);
    expect((await rows("SELECT status FROM email_outbox WHERE id = ?", [urgent]))[0]?.status).toBe("failed");
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
  });

  it("un correo inexistente es 404", async () => {
    await expect(t.services.mailQueue.retry({ emailId: 999999, supportUserId: supportId, reason: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("cancelar un correo en cola o fallido lo deja cancelado y registra la acción", async () => {
    const queued = await createEmail(pool, { status: "queued" });
    const failed = await createEmail(pool, { status: "failed" });
    await t.services.mailQueue.cancel({ emailId: queued, supportUserId: supportId, reason: "ya no aplica" });
    await t.services.mailQueue.cancel({ emailId: failed, supportUserId: supportId, reason: "ya no aplica" });
    expect((await rows("SELECT status FROM email_outbox WHERE id IN (?, ?) ORDER BY id", [queued, failed])).map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    expect((await rows("SELECT action FROM support_action_log ORDER BY id")).map((row) => row.action)).toEqual(["cancel_email", "cancel_email"]);
    await expect(t.services.mailQueue.cancel({ emailId: failed, supportUserId: supportId, reason: "otra vez" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("un correo reintentado dos veces a la vez se reencola una sola vez", async () => {
    const id = await createEmail(pool, { status: "failed", attempts: 6 });
    const results = await Promise.allSettled([
      t.services.mailQueue.retry({ emailId: id, supportUserId: supportId, reason: "a" }),
      t.services.mailQueue.retry({ emailId: id, supportUserId: supportId, reason: "b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT id FROM support_action_log")).toHaveLength(1);
  });
});

describe("el procesador guarda un código de fallo cerrado", () => {
  const failing = (error: Record<string, unknown>): MailTransport => ({
    send: async () => {
      throw Object.assign(new Error("TEXTO-DEL-SERVIDOR con datos privados"), error);
    },
  });
  const deps = (transport: MailTransport, maxAttempts: number) => ({
    db: pool,
    transport,
    tokens: t.services.tokens,
    templates: t.services.templates,
    baseUrl: "https://agenda.example.com",
    maxAttempts,
  });

  it.each([
    [{ code: "ETIMEDOUT" }, "smtp_timeout"],
    [{ code: "ECONNECTION" }, "smtp_unreachable"],
    [{ code: "EAUTH", responseCode: 535 }, "smtp_rejected"],
    [{}, "other"],
  ] as const)("el fallo %j se guarda como %s, nunca con el texto del servidor", async (error, code) => {
    await createEmail(pool, { template: "doctor_account_reactivated", payload: { doctorId: 1 }, createdAt: new Date(Date.now() - 60_000) });
    await processOutbox(deps(failing(error), 1));
    const [row] = await rows("SELECT status, last_error_code FROM email_outbox");
    expect(row).toEqual({ status: "failed", last_error_code: code });
    expect(JSON.stringify(row)).not.toContain("TEXTO-DEL-SERVIDOR");
  });

  it("una plantilla desconocida se guarda como template_error y un envío correcto limpia el código", async () => {
    await createEmail(pool, { template: "no_existe", payload: {}, createdAt: new Date(Date.now() - 60_000) });
    await processOutbox(deps(failing({}), 1));
    expect((await rows("SELECT last_error_code FROM email_outbox"))[0]?.last_error_code).toBe("template_error");

    await pool.execute("UPDATE email_outbox SET template = 'doctor_account_reactivated', payload_ref = '{\"doctorId\":1}', status = 'queued', attempts = 0, last_error_code = 'other', locked_until = NULL");
    await processOutbox(deps(t.transport, 3));
    expect((await rows("SELECT status, last_error_code FROM email_outbox"))[0]).toEqual({ status: "sent", last_error_code: null });
  });
});

describe("un correo que se está enviando no se toca", () => {
  it("cancelar o reintentar con la fila reservada por el procesador es 409", async () => {
    t.clock.set(new Date());
    const queued = await createEmail(pool, { status: "queued" });
    await pool.execute("UPDATE email_outbox SET locked_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE) WHERE id = ?", [queued]);
    await expect(t.services.mailQueue.cancel({ emailId: queued, supportUserId: supportId, reason: "x" })).rejects.toMatchObject({ code: "in_flight" });
    expect((await rows("SELECT status FROM email_outbox WHERE id = ?", [queued]))[0]?.status).toBe("queued");
    // Con la reserva vencida sí se puede.
    await pool.execute("UPDATE email_outbox SET locked_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?", [queued]);
    await t.services.mailQueue.cancel({ emailId: queued, supportUserId: supportId, reason: "x" });
    expect((await rows("SELECT status FROM email_outbox WHERE id = ?", [queued]))[0]?.status).toBe("cancelled");
  });
});
