import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, SiteUnavailableError } from "../../src/http/errors.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  createUser,
  ensurePrivacyDocument,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
} from "./helpers/db.js";
import { createTestApp, type TestApp } from "./helpers/app.js";

// Obligatoria por la constitución (principios III y V): acciones de soporte y reservas simultáneas.
const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
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

async function clinic(slug: string): Promise<CreatedDoctor> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { slug, hours: [...WEEKDAY_HOURS, ...URGENT_HOURS] });
  return doctor;
}

const stateOf = async (doctor: CreatedDoctor) => (await rows("SELECT account_state FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.account_state as string;

describe("dos personas de soporte actúan a la vez sobre la misma cuenta", () => {
  it("suspender y poner en solo lectura simultáneamente deja un único estado válido y una entrada por acción aplicada", async () => {
    for (let round = 0; round < 4; round += 1) {
      const supportOne = (await createUser(pool, { role: "support" })).id;
      const supportTwo = (await createUser(pool, { role: "support" })).id;
      const doctor = await createDoctor(pool);
      const results = await Promise.allSettled([
        t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: supportOne, reason: "a", from: "active" }),
        t.services.accountState.setReadOnly({ doctorId: doctor.doctorId, supportUserId: supportTwo, reason: "b", from: "active" }),
      ]);
      const ok = results.filter((result) => result.status === "fulfilled");
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      // Cualquier orden es válido (solo lectura → suspendida también lo es), pero cada acción aplicada deja una sola entrada.
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const failure of failed) expect(failure.reason).toBeInstanceOf(ConflictError);
      expect(["suspended", "read_only"]).toContain(await stateOf(doctor));
      expect(await rows("SELECT id FROM support_action_log WHERE target_id = ?", [doctor.doctorId])).toHaveLength(ok.length);
    }
  });

  it("la misma acción enviada dos veces a la vez (doble clic) se aplica una sola vez", async () => {
    const support = (await createUser(pool, { role: "support" })).id;
    const doctor = await createDoctor(pool);
    const results = await Promise.allSettled([
      t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: support, reason: "x", from: "active" }),
      t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: support, reason: "x", from: "active" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows("SELECT id FROM support_action_log")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox WHERE template = 'doctor_account_suspended'")).toHaveLength(1);
  });
});

describe("reservas y urgencias entrantes durante una suspensión", () => {
  it("20 reservas y una urgencia simultáneas con la suspensión terminan completas o rechazadas, sin citas a medias", async () => {
    const doctor = await clinic("clinica-rios");
    const support = (await createUser(pool, { role: "support" })).id;
    const patients = await Promise.all(Array.from({ length: 21 }, () => createPatient(pool)));
    const deps = { db: pool, clock: t.clock };
    // 20 espacios válidos: martes a viernes, cinco por día, cada hora (45 minutos más 15 de separación) desde las 9:00.
    const slots = ["16", "17", "18", "19"].flatMap((day) => ["09:00", "10:00", "11:00", "12:00", "13:00"].map((time) => `2026-06-${day}T${time}`));
    const attempts = [
      ...patients.slice(0, 20).map((patient, index) =>
        reserveAsPatient(createPatientContext(doctor.doctorId, patient.user.id), deps, { startLocal: slots[index] as string, patientId: patient.patientId, authorize: true }),
      ),
      requestUrgent(createPatientContext(doctor.doctorId, (patients[20] as { user: { id: number } }).user.id), deps, {
        patientId: (patients[20] as { patientId: number }).patientId,
        category: "naranja",
        authorize: true,
      }),
      t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: support, reason: "x", from: "active" }),
    ];
    const results = await Promise.allSettled(attempts);

    expect(await stateOf(doctor)).toBe("suspended");
    // Los únicos errores admitidos son el rechazo por no aceptar reservas (después de suspender).
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SiteUnavailableError);
    }
    // Cada cita creada está completa y ocupa un solo espacio; ninguna se creó después del cambio.
    const appointments = await rows("SELECT patient_id, start_utc, status FROM appointment ORDER BY start_utc");
    const created = results.slice(0, 21).filter((result) => result.status === "fulfilled").length;
    expect(appointments).toHaveLength(created);
    expect(new Set(appointments.map((row) => String(row.start_utc))).size).toBe(appointments.length);
    expect(appointments.every((row) => row.status === "booked")).toBe(true);
    // Con la cuenta ya suspendida, una reserva nueva se rechaza siempre.
    const late = await createPatient(pool);
    await expect(
      reserveAsPatient(createPatientContext(doctor.doctorId, late.user.id), deps, { startLocal: "2026-06-17T10:00", patientId: late.patientId, authorize: true }),
    ).rejects.toBeInstanceOf(SiteUnavailableError);
  });
});

describe("tres médicos y dos personas de soporte a la vez (SC-008)", () => {
  it("cada cuenta termina en un solo estado válido y el historial refleja cada acción aplicada una sola vez", async () => {
    const supportOne = (await createUser(pool, { role: "support" })).id;
    const supportTwo = (await createUser(pool, { role: "support" })).id;
    const doctors = [await createDoctor(pool), await createDoctor(pool), await createDoctor(pool)];
    const calls = doctors.flatMap((doctor) => [
      t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: supportOne, reason: "a", from: "active" }),
      t.services.accountState.setReadOnly({ doctorId: doctor.doctorId, supportUserId: supportTwo, reason: "b", from: "active" }),
      t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: supportTwo, reason: "c", from: "read_only" }),
    ]);
    const results = await Promise.allSettled(calls);
    const applied = results.filter((result) => result.status === "fulfilled").length;
    for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ConflictError);
    for (const doctor of doctors) expect(["suspended", "read_only"]).toContain(await stateOf(doctor));
    expect(await rows("SELECT id FROM support_action_log")).toHaveLength(applied);
    // Una entrada de historial por cambio realmente aplicado, y un solo aviso por cada una.
    const notices = await rows("SELECT id FROM email_outbox WHERE template IN ('doctor_account_suspended','doctor_account_read_only')");
    expect(notices).toHaveLength(applied);
  });
});
