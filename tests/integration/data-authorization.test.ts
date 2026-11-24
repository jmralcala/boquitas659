import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LegalReviewPendingError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { withCalendarLock } from "../../src/modules/calendar/calendar-lock.js";
import { revokeAccountLinks } from "../../src/modules/patients/patient-repository.js";
import { hasActiveAuthorization, recordAuthorization } from "../../src/modules/site/authorization.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createTestPool,
  ensurePrivacyDocument,
  linkPatientToDoctor,
  resetDatabase,
} from "./helpers/db.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  clock.set(new Date("2026-06-15T14:00:00.000Z"));
});

afterAll(async () => {
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function setup() {
  const doctor = await createDoctor(pool);
  const patient = await createPatient(pool);
  const ctx = createPatientContext(doctor.doctorId, patient.user.id);
  return { doctor, patient, ctx };
}

describe("recordAuthorization", () => {
  it("guarda cuenta, consultorio, quién, versión vigente del aviso y fecha, y deja la fila data_authorized", async () => {
    const s = await setup();
    const documentId = await ensurePrivacyDocument(pool);
    await withCalendarLock(s.ctx, pool, (connection) => recordAuthorization(s.ctx, connection, { accountId: s.patient.accountId, now: clock.now() }));
    const [row] = await rows("SELECT * FROM data_authorization");
    expect(row).toMatchObject({
      account_id: s.patient.accountId,
      doctor_id: s.doctor.doctorId,
      given_by_user_id: s.patient.user.id,
      legal_document_id: documentId,
    });
    expect((row?.accepted_at as Date).toISOString()).toBe(clock.now().toISOString());
    const [log] = await rows("SELECT doctor_id, actor_user_id, actor_role, action, outcome, occurred_at FROM calendar_action_log WHERE action = 'data_authorized'");
    expect(log).toMatchObject({ doctor_id: s.doctor.doctorId, actor_user_id: s.patient.user.id, actor_role: "patient", outcome: "ok" });
    expect((log?.occurred_at as Date).toISOString()).toBe(clock.now().toISOString());
  });

  it("usa la versión MÁS RECIENTE del aviso de privacidad", async () => {
    const s = await setup();
    await ensurePrivacyDocument(pool);
    await pool.execute("INSERT INTO legal_document (type, version, title, body, is_provisional, published_at) VALUES ('patient_privacy', 2, 'Aviso 2', 'Texto', 0, UTC_TIMESTAMP(3))");
    const [latest] = await rows("SELECT id FROM legal_document WHERE type = 'patient_privacy' AND version = 2");
    await recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: clock.now() });
    expect((await rows("SELECT legal_document_id FROM data_authorization"))[0]?.legal_document_id).toBe(latest?.id);
  });

  it("sin documento legal vigente no se puede autorizar (y no queda nada)", async () => {
    const s = await setup();
    await expect(recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: clock.now() })).rejects.toBeInstanceOf(LegalReviewPendingError);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });

  it("la tabla es de solo anexar", async () => {
    const s = await setup();
    await ensurePrivacyDocument(pool);
    await recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: clock.now() });
    await expect(pool.execute("UPDATE data_authorization SET accepted_at = UTC_TIMESTAMP(3)")).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("DELETE FROM data_authorization")).rejects.toThrow(/solo anexar/);
  });

  it("si la transacción se revierte, no queda autorización ni acción registrada", async () => {
    const s = await setup();
    await ensurePrivacyDocument(pool);
    await expect(
      withCalendarLock(s.ctx, pool, async (connection) => {
        await recordAuthorization(s.ctx, connection, { accountId: s.patient.accountId, now: clock.now() });
        throw new Error("falla posterior");
      }),
    ).rejects.toThrow("falla posterior");
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });
});

describe("hasActiveAuthorization", () => {
  it("no es activa sin autorización, aunque el personal haya vinculado al paciente", async () => {
    const s = await setup();
    await linkPatientToDoctor(pool, s.doctor.doctorId, s.patient.patientId);
    expect(await hasActiveAuthorization(s.ctx, pool, s.patient.accountId)).toBe(false);
  });

  it("es activa tras autorizar, y es por cuenta y por consultorio", async () => {
    const s = await setup();
    const otherDoctor = await createDoctor(pool);
    await ensurePrivacyDocument(pool);
    await recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: clock.now() });
    expect(await hasActiveAuthorization(s.ctx, pool, s.patient.accountId)).toBe(true);
    expect(await hasActiveAuthorization(createPatientContext(otherDoctor.doctorId, s.patient.user.id), pool, s.patient.accountId)).toBe(false);
    const other = await createPatient(pool);
    expect(await hasActiveAuthorization(s.ctx, pool, other.accountId)).toBe(false);
  });

  it("deja de ser activa al revocar el vínculo y vuelve a serlo con una autorización posterior", async () => {
    const s = await setup();
    await ensurePrivacyDocument(pool);
    await linkPatientToDoctor(pool, s.doctor.doctorId, s.patient.patientId);
    await recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: new Date("2026-06-15T14:00:00.000Z") });
    await revokeAccountLinks(s.ctx, pool, s.patient.accountId, new Date("2026-06-16T14:00:00.000Z"));
    expect(await hasActiveAuthorization(s.ctx, pool, s.patient.accountId)).toBe(false);
    await recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: new Date("2026-06-17T14:00:00.000Z") });
    expect(await hasActiveAuthorization(s.ctx, pool, s.patient.accountId)).toBe(true);
  });

  it("la autorización es de la cuenta (la da el titular o tutor), así que cubre también a un menor", async () => {
    const s = await setup();
    await ensurePrivacyDocument(pool);
    await recordAuthorization(s.ctx, pool, { accountId: s.patient.accountId, now: clock.now() });
    expect(await hasActiveAuthorization(s.ctx, pool, s.patient.accountId)).toBe(true);
    expect((await rows("SELECT given_by_user_id FROM data_authorization"))[0]?.given_by_user_id).toBe(s.patient.user.id);
  });
});
