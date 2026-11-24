import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/http/errors.js";
import { createPatientContext, createTenantContext } from "../../src/lib/tenant.js";
import { findPatientForDoctor, listPatientNamesForDoctor } from "../../src/modules/patients/patient-repository.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { listOffices, previewRevocation, revoke } from "../../src/modules/site/offices-service.js";
import {
  clearTables,
  createAppointment,
  createDataAuthorization,
  createDependent,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, localAt, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z");

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

const deps = () => ({ db: pool, clock: t.clock });

async function doctorWithSite(name: string, slug: string): Promise<CreatedDoctor> {
  const doctor = await createDoctor(pool, { fullName: name });
  await createPublishedSite(pool, doctor, { slug });
  return doctor;
}

interface Account {
  owner: CreatedPatient;
  minorId: number;
}

async function account(): Promise<Account> {
  const owner = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  return { owner, minorId: await createDependent(pool, owner.accountId, "Hijo de Mario") };
}

/** Cita directa con vínculo (origen paciente) y autorización de la cuenta con el consultorio. */
async function link(doctor: CreatedDoctor, who: Account, patientId: number, startUtc: Date, status: "booked" | "cancelled" = "booked"): Promise<number> {
  const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId, startUtc, status, createdByUserId: who.owner.user.id, createdByRole: "patient", createdAt: new Date(NOW.getTime() - 3 * 86_400_000) });
  await pool.execute("UPDATE doctor_patient SET origin = 'patient' WHERE doctor_id = ? AND patient_id = ?", [doctor.doctorId, patientId]);
  return id;
}

describe("listOffices", () => {
  it("lista los vínculos activos de la cuenta con origen y fecha, sin los revocados ni los de otras cuentas", async () => {
    const a = await doctorWithSite("Dra. Elena Ríos", "clinica-rios");
    const b = await doctorWithSite("Dr. Otro Consultorio", "otro-consultorio");
    const c = await doctorWithSite("Dr. Revocado", "revocado");
    const who = await account();
    await link(a, who, who.owner.patientId, new Date(NOW.getTime() + 86_400_000));
    await link(a, who, who.minorId, new Date(NOW.getTime() + 2 * 86_400_000));
    await createAppointment(pool, { doctorId: b.doctorId, patientId: who.owner.patientId, startUtc: new Date(NOW.getTime() + 86_400_000) }); // lo creó el consultorio
    await link(c, who, who.owner.patientId, new Date(NOW.getTime() + 86_400_000));
    await pool.execute("UPDATE doctor_patient SET revoked_at = ? WHERE doctor_id = ?", [NOW, c.doctorId]);
    const stranger = await createPatient(pool);
    await createAppointment(pool, { doctorId: c.doctorId, patientId: stranger.patientId, startUtc: new Date(NOW.getTime() + 2 * 86_400_000) });

    const offices = await listOffices(pool, who.owner.user.id);
    expect(offices.map((office) => office.doctorName).sort()).toEqual(["Dr. Otro Consultorio", "Dra. Elena Ríos"]);
    expect(offices.find((office) => office.doctorId === a.doctorId)?.origin).toBe("patient");
    expect(offices.find((office) => office.doctorId === b.doctorId)?.origin).toBe("office");
    expect(offices[0]?.linkedAt).toBeInstanceOf(Date);
  });
});

describe("previewRevocation", () => {
  it("cuenta las citas futuras vigentes de toda la cuenta con el consultorio y da 404 sin vínculo activo", async () => {
    const a = await doctorWithSite("Dra. Elena Ríos", "clinica-rios");
    const who = await account();
    await link(a, who, who.owner.patientId, new Date(NOW.getTime() + 86_400_000));
    await link(a, who, who.minorId, new Date(NOW.getTime() + 2 * 86_400_000));
    await link(a, who, who.owner.patientId, new Date(NOW.getTime() + 3 * 86_400_000), "cancelled");
    await link(a, who, who.owner.patientId, new Date(NOW.getTime() - 5 * 86_400_000)); // pasada
    expect(await previewRevocation(pool, who.owner.user.id, a.doctorId, NOW)).toMatchObject({ doctorName: "Dra. Elena Ríos", futureAppointments: 2 });
    const other = await doctorWithSite("Dr. Sin Vínculo", "sin-vinculo");
    await expect(previewRevocation(pool, who.owner.user.id, other.doctorId, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("revoke", () => {
  async function prepared() {
    const a = await doctorWithSite("Dra. Elena Ríos", "clinica-rios");
    const b = await doctorWithSite("Dr. Otro Consultorio", "otro-consultorio");
    const who = await account();
    await createDataAuthorization(pool, { accountId: who.owner.accountId, doctorId: a.doctorId, userId: who.owner.user.id, at: new Date(NOW.getTime() - 86_400_000) });
    const ids = {
      owner1: await link(a, who, who.owner.patientId, localAt(MX, "2026-06-18", "10:00")),
      owner2: await link(a, who, who.owner.patientId, localAt(MX, "2026-06-19", "10:00")),
      minor: await link(a, who, who.minorId, localAt(MX, "2026-06-22", "10:00")),
      past: await link(a, who, who.owner.patientId, new Date(NOW.getTime() - 5 * 86_400_000)),
      elsewhere: await link(b, who, who.owner.patientId, localAt(MX, "2026-06-18", "11:00")),
    };
    return { a, b, who, ids };
  }

  it("cancela las citas futuras de TODA la cuenta con ese consultorio, revoca todos los vínculos y deja constancia", async () => {
    const { a, b, who, ids } = await prepared();
    const result = await revoke(deps(), who.owner.user.id, a.doctorId);
    expect(result.cancelled).toBe(3);

    const status = async (id: number) => (await rows("SELECT status, cancelled_by_role FROM appointment WHERE id = ?", [id]))[0];
    for (const id of [ids.owner1, ids.owner2, ids.minor]) expect(await status(id)).toMatchObject({ status: "cancelled", cancelled_by_role: "patient" });
    expect((await status(ids.past))?.status).toBe("booked"); // las pasadas se conservan
    expect((await status(ids.elsewhere))?.status).toBe("booked"); // otro consultorio no se toca

    expect(await rows("SELECT patient_id FROM doctor_patient WHERE doctor_id = ? AND revoked_at IS NOT NULL ORDER BY patient_id", [a.doctorId])).toHaveLength(2);
    expect(await rows("SELECT patient_id FROM doctor_patient WHERE doctor_id = ? AND revoked_at IS NULL", [b.doctorId])).toHaveLength(1);

    const log = await rows("SELECT action, actor_role FROM calendar_action_log WHERE doctor_id = ? ORDER BY id", [a.doctorId]);
    expect(log.filter((row) => row.action === "link_revoked")).toHaveLength(1);
    expect(log.filter((row) => row.action === "appointment_cancelled")).toHaveLength(3);
    expect(log.every((row) => row.actor_role === "patient")).toBe(true);

    // Un aviso al médico por cada cita y la constancia al paciente.
    const outbox = await rows("SELECT template, to_email, payload_ref FROM email_outbox");
    expect(outbox.filter((row) => row.template === "doctor_appointment_cancelled")).toHaveLength(3);
    expect(outbox.filter((row) => row.template === "appointment_cancelled_by_patient")).toHaveLength(3);
    for (const row of outbox.filter((entry) => entry.template === "doctor_appointment_cancelled")) {
      expect(JSON.parse(String(row.payload_ref))).toMatchObject({ reason: "revoked" });
      expect(row.to_email).toBe(a.user.email);
    }
    await t.runOutbox();
    const notice = t.transport.sent.find((sent) => sent.to === a.user.email);
    expect(notice?.text).toContain("el paciente retiró su vínculo con el consultorio");
    expect(notice?.text).not.toContain("5512345678");
  });

  it("el consultorio deja de ver el contacto pero conserva los nombres de las citas pasadas", async () => {
    const { a, who } = await prepared();
    const staff = createTenantContext(a.doctorId, { kind: "doctor", userId: a.user.id });
    expect(await findPatientForDoctor(staff, pool, who.owner.patientId)).not.toBeNull();
    await revoke(deps(), who.owner.user.id, a.doctorId);
    expect(await findPatientForDoctor(staff, pool, who.owner.patientId)).toBeNull();
    expect((await listPatientNamesForDoctor(staff, pool, [who.owner.patientId])).get(who.owner.patientId)).toBe("Mario Quintana");
  });

  it("revocar dos veces da NotFoundError la segunda; otra cuenta no puede revocar el vínculo ajeno", async () => {
    const { a, who } = await prepared();
    const stranger = await createPatient(pool);
    await expect(revoke(deps(), stranger.user.id, a.doctorId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT id FROM doctor_patient WHERE revoked_at IS NOT NULL")).toEqual([]);
    await revoke(deps(), who.owner.user.id, a.doctorId);
    await expect(revoke(deps(), who.owner.user.id, a.doctorId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(revoke(deps(), who.owner.user.id, 987_654)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("después de revocar, reservar de nuevo exige una nueva autorización y reactiva el vínculo", async () => {
    const { a, who } = await prepared();
    await revoke(deps(), who.owner.user.id, a.doctorId);
    t.clock.advance(60_000);
    const ctx = createPatientContext(a.doctorId, who.owner.user.id);
    await expect(reserveAsPatient(ctx, deps(), { startLocal: "2026-06-23T10:00", patientId: who.owner.patientId, authorize: false })).rejects.toMatchObject({ fields: { autorizo: expect.anything() } });
    await reserveAsPatient(ctx, deps(), { startLocal: "2026-06-23T10:00", patientId: who.owner.patientId, authorize: true });
    expect(await rows("SELECT revoked_at FROM doctor_patient WHERE doctor_id = ? AND patient_id = ?", [a.doctorId, who.owner.patientId])).toEqual([{ revoked_at: null }]);
  });

  it("revocar y reservar a la vez: nunca queda una cita vigente sin una nueva autorización", async () => {
    const a = await doctorWithSite("Dra. Elena Ríos", "clinica-rios");
    for (let round = 0; round < 8; round += 1) {
      const owner = await createPatient(pool);
      await createDataAuthorization(pool, { accountId: owner.accountId, doctorId: a.doctorId, userId: owner.user.id, at: new Date(NOW.getTime() - 86_400_000) });
      await pool.execute("INSERT INTO doctor_patient (doctor_id, patient_id, origin) VALUES (?, ?, 'patient')", [a.doctorId, owner.patientId]);
      const ctx = createPatientContext(a.doctorId, owner.user.id);
      const date = ["2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-29"][round] ?? "2026-06-30";
      await Promise.allSettled([
        revoke(deps(), owner.user.id, a.doctorId),
        reserveAsPatient(ctx, deps(), { startLocal: `${date}T10:00`, patientId: owner.patientId, authorize: false }),
      ]);
      const booked = await rows("SELECT id FROM appointment WHERE patient_id = ? AND status = 'booked'", [owner.patientId]);
      expect(booked, `ronda ${round}`).toEqual([]);
      expect((await rows("SELECT revoked_at FROM doctor_patient WHERE patient_id = ?", [owner.patientId]))[0]?.revoked_at).not.toBeNull();
    }
  });
});
