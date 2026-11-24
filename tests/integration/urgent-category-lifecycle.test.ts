import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireUrgentCategories } from "../../src/jobs/urgent-notices.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
} from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

// Constitución I: la categoría vive solo en la cola de envío y se borra al entregarse o a las 24 h como máximo.
const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const URGENT = [{ weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60, kind: "urgent" as const }];

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  (t.transport.sent as unknown[]).length = 0;
  t.transport.failNext(0);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const payloadOf = (row: RowDataPacket | undefined): Record<string, unknown> => JSON.parse(String(row?.payload_ref)) as Record<string, unknown>;

async function agendada(): Promise<{ doctor: CreatedDoctor; appointmentId: number }> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { hours: URGENT });
  const patient = await createPatient(pool, { email: "mario@example.com" });
  const result = await requestUrgent(createPatientContext(doctor.doctorId, patient.user.id), { db: pool, clock: t.clock }, { patientId: patient.patientId, category: "rojo", authorize: true });
  if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
  return { doctor, appointmentId: result.id };
}

const urgentNotice = async () => (await rows("SELECT id, template, status, attempts, to_email, payload_ref FROM email_outbox WHERE template IN ('doctor_urgent_notice', 'doctor_urgent_generic') ORDER BY id"));

describe("ciclo de vida de la categoría", () => {
  it("mientras el aviso espera en cola la categoría sigue presente", async () => {
    const s = await agendada();
    const [notice] = await urgentNotice();
    expect(notice?.template).toBe("doctor_urgent_notice");
    expect(payloadOf(notice)).toEqual({ appointmentId: s.appointmentId, category: "rojo" });
  });

  it("al entregarse, la categoría desaparece de la cola", async () => {
    const s = await agendada();
    await t.runOutbox();
    const [notice] = await urgentNotice();
    expect(notice?.status).toBe("sent");
    expect(payloadOf(notice)).toEqual({ appointmentId: s.appointmentId });
    expect(JSON.stringify(await rows("SELECT payload_ref FROM email_outbox"))).not.toContain("rojo");
  });

  it("al cancelarse la urgencia antes del envío, la categoría desaparece y el aviso no sale", async () => {
    const s = await agendada();
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [NOW, s.appointmentId]);
    await t.runOutbox();
    const [notice] = await urgentNotice();
    expect(notice?.status).toBe("cancelled");
    expect(payloadOf(notice)).toEqual({ appointmentId: s.appointmentId });
  });

  it("si el envío falla definitivamente, la categoría se borra y el médico recibe el aviso genérico sin categoría", async () => {
    const second = await agendada();
    t.transport.failNext(100);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.runOutbox();
      t.clock.advance(5 * MINUTE); // la espera entre reintentos es de 1 y 2 minutos; la cita (10:00) aún no empieza
    }
    const [failed, generic] = await urgentNotice();
    expect(failed).toMatchObject({ template: "doctor_urgent_notice", status: "failed" });
    expect(payloadOf(failed)).toEqual({ appointmentId: second.appointmentId });
    expect(generic).toMatchObject({ template: "doctor_urgent_generic", status: "queued", to_email: second.doctor.user.email });
    expect(payloadOf(generic)).toEqual({ appointmentId: second.appointmentId });
    expect(JSON.stringify(await urgentNotice())).not.toContain("rojo");

    t.transport.failNext(0);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.subject === "Tienes una urgencia agendada");
    expect(message?.to).toBe(second.doctor.user.email);
    expect(message?.text.toLowerCase()).not.toContain("rojo");
    expect(message?.text.toLowerCase()).not.toContain("categoría");
  });
});

describe("expiración a las 24 horas", () => {
  it("una fila en cola con 23 h 59 min conserva la categoría; a las 24 h se convierte en aviso genérico sin categoría", async () => {
    const s = await agendada();
    t.clock.set(new Date(NOW.getTime() + 24 * HOUR - MINUTE));
    expect(await expireUrgentCategories(pool, t.clock)).toBe(0);
    expect(payloadOf((await urgentNotice())[0])).toEqual({ appointmentId: s.appointmentId, category: "rojo" });

    t.clock.set(new Date(NOW.getTime() + 24 * HOUR));
    expect(await expireUrgentCategories(pool, t.clock)).toBe(1);
    const [row] = await urgentNotice();
    expect(row).toMatchObject({ template: "doctor_urgent_generic", status: "queued" });
    expect(payloadOf(row)).toEqual({ appointmentId: s.appointmentId });
    expect(JSON.stringify(row)).not.toContain("rojo");
  });

  it("el aviso genérico sale en el siguiente ciclo del outbox", async () => {
    const s = await agendada();
    t.clock.set(new Date(NOW.getTime() + 25 * HOUR));
    // La cita del lunes 10:00 ya pasó; el aviso genérico no depende del estado de la cita.
    await expireUrgentCategories(pool, t.clock);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === s.doctor.user.email);
    expect(message?.subject).toBe("Tienes una urgencia agendada");
    expect(message?.text.toLowerCase()).not.toContain("rojo");
  });

  it("es idempotente: correrlo varias veces, o dos procesos a la vez, no duplica avisos", async () => {
    await agendada();
    t.clock.set(new Date(NOW.getTime() + 24 * HOUR));
    const counts = await Promise.all([1, 2, 3, 4].map(() => expireUrgentCategories(pool, t.clock)));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await expireUrgentCategories(pool, t.clock)).toBe(0);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'doctor_urgent_generic'")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'doctor_urgent_notice'")).toEqual([]);
  });

  it("no toca los avisos ya enviados ni los de otras plantillas", async () => {
    await agendada();
    await t.runOutbox(); // enviados
    t.clock.set(new Date(NOW.getTime() + 48 * HOUR));
    expect(await expireUrgentCategories(pool, t.clock)).toBe(0);
    expect((await urgentNotice())[0]?.status).toBe("sent");
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'appointment_created'")).toHaveLength(1);
  });

  it("sin filas pendientes no hace nada", async () => {
    expect(await expireUrgentCategories(pool, t.clock)).toBe(0);
  });
});
