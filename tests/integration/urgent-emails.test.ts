import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { TRIAGE_CONTENT, type CategoryId } from "../../src/modules/urgent/triage-content.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createDependent,
  createDoctor,
  createMembership,
  createPatient,
  createPublishedSite,
  createTestPool,
  createUser,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const URGENT = [{ weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60, kind: "urgent" as const }]; // 10:00 y 11:00

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

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
}

async function scenario(hours: NonNullable<NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]> = URGENT): Promise<Scenario> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, { hours });
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  return { doctor, patient };
}

const request = (s: Scenario, category: CategoryId = "naranja", patientId = s.patient.patientId) =>
  requestUrgent(createPatientContext(s.doctor.doctorId, s.patient.user.id), { db: pool, clock: t.clock }, { patientId, category, authorize: true });

const payloadOf = (row: RowDataPacket | undefined): Record<string, unknown> => JSON.parse(String(row?.payload_ref)) as Record<string, unknown>;

describe("correos al agendar una urgencia", () => {
  it("el paciente recibe la confirmación con día y hora locales, dirección, teléfono, enlace y Reply-To del médico, sin la categoría", async () => {
    const s = await scenario();
    await request(s, "rojo");
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(message).toBeDefined();
    expect(message?.subject).toBe("Tu cita dental fue agendada");
    expect(message?.replyTo).toBe(s.doctor.user.email);
    expect(message?.text).toContain("urgencia");
    expect(message?.text).toContain("Dra. Elena Ríos");
    expect(message?.text).toContain("Mario Quintana");
    expect(message?.text).toContain("10:00");
    expect(message?.text).toContain("Calle Falsa 123, Centro");
    expect(message?.text).toContain("5598765432");
    expect(message?.text).toMatch(/https?:\/\/\S+\/citas\/enlace\/\S+/);
    expect(message?.text.toLowerCase()).not.toContain("rojo");
    expect(message?.subject).not.toMatch(/Mario|Ríos|rojo/i);
  });

  it("el médico recibe la categoría, el día y la hora en el correo de su cuenta, sin nombre del paciente ni datos de contacto", async () => {
    const s = await scenario();
    await pool.execute("UPDATE patient SET phone = '5511112222' WHERE id = ?", [s.patient.patientId]);
    await request(s, "naranja");
    await t.runOutbox();
    const notice = t.transport.sent.find((sent) => sent.to === s.doctor.user.email);
    expect(notice).toBeDefined();
    expect(notice?.subject).toBe("Nueva urgencia agendada");
    expect(notice?.subject).not.toMatch(/Mario|naranja/i);
    expect(notice?.text).toContain("Naranja");
    expect(notice?.text).toContain("10:00");
    expect(notice?.text.toLowerCase()).toContain("lunes");
    expect(notice?.text).toContain("/agenda/dia/2026-06-15");
    expect(notice?.text).not.toContain("Mario");
    expect(notice?.text).not.toContain("Quintana");
    expect(notice?.text).not.toContain("mario@example.com");
    expect(notice?.text).not.toContain("5511112222");
    expect(notice?.replyTo).toBeUndefined();
  });

  it("nombra la categoría con el texto del semáforo, no con un valor libre del paciente", async () => {
    for (const category of TRIAGE_CONTENT.categories) {
      await clearTables(pool);
      await ensurePrivacyDocument(pool);
      (t.transport.sent as unknown[]).length = 0;
      const s = await scenario();
      await request(s, category.id);
      await t.runOutbox();
      const notice = t.transport.sent.find((sent) => sent.to === s.doctor.user.email);
      expect(notice?.text, category.id).toContain(category.label);
      expect(notice?.text, category.id).not.toContain(category.optionText);
    }
  });

  it("recepción no recibe el aviso: solo la cuenta del médico", async () => {
    const s = await scenario();
    const reception = await createUser(pool, { role: "reception", email: "recepcion@example.com" });
    await createMembership(pool, s.doctor.doctorId, reception.id);
    await request(s);
    await t.runOutbox();
    expect(t.transport.sent.map((sent) => sent.to).sort()).toEqual([s.doctor.user.email, "mario@example.com"].sort());
  });

  it("para un menor, los correos van a la cuenta del tutor y nombran al menor", async () => {
    const s = await scenario();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Mario");
    await request(s, "amarillo", minorId);
    await t.runOutbox();
    const message = t.transport.sent.find((sent) => sent.to === "mario@example.com");
    expect(message?.text).toContain("Hijo de Mario");
  });

  it("el outbox guarda {appointmentId, category} solo en el aviso al médico y {appointmentId} en el del paciente", async () => {
    const s = await scenario();
    const result = await request(s, "verde");
    if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
    const outbox = await rows("SELECT template, to_email, payload_ref FROM email_outbox ORDER BY id");
    expect(outbox.map((row) => row.template).sort()).toEqual(["appointment_created", "doctor_urgent_notice"]);
    expect(payloadOf(outbox.find((row) => row.template === "appointment_created"))).toEqual({ appointmentId: result.id });
    expect(payloadOf(outbox.find((row) => row.template === "doctor_urgent_notice"))).toEqual({ appointmentId: result.id, category: "verde" });
    expect(outbox.find((row) => row.template === "doctor_urgent_notice")?.to_email).toBe(s.doctor.user.email);
  });

  it("se encolan en la misma transacción que la cita: una solicitud sin espacio no encola nada", async () => {
    const s = await scenario([]);
    expect((await request(s)).kind).toBe("no_space");
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("un doble envío no encola correos nuevos", async () => {
    const s = await scenario();
    await request(s);
    await request(s);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(2);
  });

  it("si la urgencia se cancela antes del envío, el aviso al médico no sale y la fila queda cancelada sin categoría", async () => {
    const s = await scenario();
    const result = await request(s, "rojo");
    if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [NOW, result.id]);
    await t.runOutbox();
    expect(t.transport.sent).toEqual([]);
    const notice = (await rows("SELECT status, payload_ref FROM email_outbox WHERE template = 'doctor_urgent_notice'"))[0];
    expect(notice?.status).toBe("cancelled");
    expect(payloadOf(notice)).toEqual({ appointmentId: result.id });
  });

  it("un correo que falla no deshace la cita", async () => {
    const s = await scenario();
    const result = await request(s);
    t.transport.failNext(10);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.runOutbox();
      t.clock.advance(2 * 3_600_000);
    }
    if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [result.id]))[0]?.status).toBe("booked");
  });
});

describe("entrega a tiempo (los avisos de urgencia no dependen de cuotas ni de planes)", () => {
  it("el aviso al médico sale en UNA sola ejecución del outbox tras agendar (el siguiente ciclo del cron)", async () => {
    const s = await scenario();
    await request(s);
    const result = await t.runOutbox();
    expect(result.sent).toBe(2);
    expect(t.transport.sent.some((sent) => sent.to === s.doctor.user.email)).toBe(true);
  });
});
