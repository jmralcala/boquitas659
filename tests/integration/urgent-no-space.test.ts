import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createAppointment,
  createDataAuthorization,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  WEEKDAY_HOURS,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
const deps = { db: pool, clock };
const MX = "America/Mexico_City";
const MONDAY = "2026-06-15";

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock.set(new Date("2026-06-15T14:00:00.000Z"));
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function noSpaceScenario(hours: NonNullable<NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]> = []) {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { hours });
  const patient = await createPatient(pool);
  return { doctor, patient, ctx: createPatientContext(doctor.doctorId, patient.user.id) };
}

describe("requestUrgent: sin espacio", () => {
  it("devuelve no_space y NO crea cita, vínculo ni autorización; deja una fila rechazada sin cita ni categoría", async () => {
    const s = await noSpaceScenario();
    const result = await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "rojo", authorize: true });
    expect(result).toEqual({ kind: "no_space" });
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
    // La transacción se CONFIRMA (la fila queda aunque no haya cita) y no lleva categoría.
    expect(await rows("SELECT action, outcome, actor_role, appointment_id, doctor_id, actor_user_id FROM calendar_action_log")).toEqual([
      { action: "urgent_requested", outcome: "rejected", actor_role: "patient", appointment_id: null, doctor_id: s.doctor.doctorId, actor_user_id: s.patient.user.id },
    ]);
    expect(JSON.stringify(await rows("SELECT * FROM calendar_action_log"))).not.toMatch(/rojo|categor/i);
  });

  it("no encola ningún correo (ni al paciente ni al médico)", async () => {
    const s = await noSpaceScenario();
    await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "rojo", authorize: true });
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("con un vínculo y una autorización ya existentes no los toca", async () => {
    const s = await noSpaceScenario();
    await createDataAuthorization(pool, { accountId: s.patient.accountId, doctorId: s.doctor.doctorId, userId: s.patient.user.id, at: new Date("2026-06-01T00:00:00Z") });
    const result = await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "naranja", authorize: false });
    expect(result.kind).toBe("no_space");
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
  });

  it("sin franjas de urgencia usa el espacio convencional libre más próximo dentro de la ventana", async () => {
    const s = await noSpaceScenario(WEEKDAY_HOURS);
    const result = await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "rojo", authorize: true });
    expect(result.kind).toBe("scheduled");
    if (result.kind === "scheduled") expect(result.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "09:00").toISOString());
    expect((await rows("SELECT kind FROM appointment"))[0]?.kind).toBe("urgent");
  });

  it("un espacio libre DESPUÉS de la ventana no se asigna", async () => {
    const s = await noSpaceScenario([{ weekday: 1, startMinute: 18 * 60, endMinute: 19 * 60 }]); // lunes 18:00, a 10 h
    expect((await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "rojo", authorize: true })).kind).toBe("no_space"); // ventana de 2 h
    expect((await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "naranja", authorize: true })).kind).toBe("scheduled"); // ventana de 12 h
  });

  it("con todo ocupado en la ventana devuelve no_space aunque haya franjas", async () => {
    const s = await noSpaceScenario([{ weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 }]);
    const other = await createPatient(pool);
    for (const time of ["09:00", "10:00"]) await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, MONDAY, time) });
    expect((await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "naranja", authorize: true })).kind).toBe("no_space");
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(2);
  });

  it("cada solicitud sin espacio deja su propia fila (cuenta para las 3 por 24 h)", async () => {
    const s = await noSpaceScenario();
    for (let index = 0; index < 3; index += 1) await requestUrgent(s.ctx, deps, { patientId: s.patient.patientId, category: "verde", authorize: true });
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested' AND outcome = 'rejected'")).toHaveLength(3);
  });
});
