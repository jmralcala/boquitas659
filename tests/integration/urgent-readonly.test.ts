import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SiteUnavailableError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
import { clearTables, createDoctor, createPatient, createPublishedSite, createTestPool, ensurePrivacyDocument, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));
const URGENT = [{ weekday: 1, startMinute: 10 * 60, endMinute: 12 * 60, kind: "urgent" as const }];

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql);
  return result;
}

async function setup() {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { hours: URGENT });
  const patient = await createPatient(pool);
  return { doctor, patient, ctx: createPatientContext(doctor.doctorId, patient.user.id) };
}

const request = (s: Awaited<ReturnType<typeof setup>>) => requestUrgent(s.ctx, { db: pool, clock }, { patientId: s.patient.patientId, category: "naranja", authorize: true });

describe("requestUrgent revalida el servicio dentro de la transacción", () => {
  it.each([
    ["despublicado después de que la ruta lo comprobó", "UPDATE doctor_site SET status = 'unpublished'"],
    ["el médico dejó de estar aprobado", "UPDATE doctor SET approval_status = 'rejected'"],
    ["el micrositio se eliminó", "DELETE FROM doctor_site"],
  ])("%s: SiteUnavailableError y no queda nada", async (_label, sql) => {
    const s = await setup();
    await pool.execute(sql);
    await expect(request(s)).rejects.toBeInstanceOf(SiteUnavailableError);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("al volver a publicar, la solicitud funciona de nuevo", async () => {
    const s = await setup();
    await pool.execute("UPDATE doctor_site SET status = 'unpublished'");
    await expect(request(s)).rejects.toBeInstanceOf(SiteUnavailableError);
    await pool.execute("UPDATE doctor_site SET status = 'published'");
    expect((await request(s)).kind).toBe("scheduled");
  });
});
