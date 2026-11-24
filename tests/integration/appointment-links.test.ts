import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import type { SessionData } from "../../src/modules/auth/sessions.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import {
  clearTables,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { createTestApp, linkTokenSentTo, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
  (t.transport.sent as unknown[]).length = 0;
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

interface Booked {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
  appointmentId: number;
  token: string;
}

async function booked(): Promise<Booked> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor);
  const patient = await createPatient(pool, { fullName: "Mario Quintana", email: "mario@example.com" });
  const result = await reserveAsPatient(createPatientContext(doctor.doctorId, patient.user.id), { db: pool, clock: t.clock }, { startLocal: `${TUESDAY}T10:00`, patientId: patient.patientId, authorize: true });
  const token = await linkTokenSentTo(t, "mario@example.com", "/citas/enlace");
  return { doctor, patient, appointmentId: result.id, token };
}

async function sessionOf(patient: CreatedPatient): Promise<SessionData> {
  const { token } = await t.services.sessions.create(patient.user.id);
  const session = await t.services.sessions.validate(token);
  if (!session) throw new Error("sin sesión");
  return session;
}

describe("resolve: valida sin consumir", () => {
  it("sin sesión pide iniciar sesión; con la sesión de la cuenta dueña muestra el resumen", async () => {
    const b = await booked();
    expect(await t.services.links.resolve(b.token, null)).toEqual({ kind: "login_required" });
    const resolution = await t.services.links.resolve(b.token, await sessionOf(b.patient));
    expect(resolution.kind).toBe("summary");
    if (resolution.kind !== "summary") return;
    expect(resolution.summary).toMatchObject({ appointmentId: b.appointmentId, doctorName: "Dra. Elena Ríos", patientName: "Mario Quintana", address: "Calle Falsa 123, Centro", cancelable: true });
    // Cita el martes 10:00 locales; el médico exige 24 h: se puede cancelar hasta el lunes 10:00.
    expect(resolution.summary.cancelDeadline.toISOString()).toBe("2026-06-15T16:00:00.000Z");
  });

  it("abrirlo 100 veces (con y sin sesión, con otra cuenta) no cambia la cita ni el token", async () => {
    const b = await booked();
    const other = await createPatient(pool);
    const owner = await sessionOf(b.patient);
    const stranger = await sessionOf(other);
    const before = {
      appointment: await rows("SELECT * FROM appointment"),
      tokens: await rows("SELECT token_hash, used_at, expires_at FROM one_time_token"),
      outbox: await rows("SELECT id, status FROM email_outbox"),
    };
    for (let index = 0; index < 100; index += 1) {
      await t.services.links.resolve(b.token, [null, owner, stranger][index % 3] ?? null);
    }
    expect(await rows("SELECT * FROM appointment")).toEqual(before.appointment);
    expect(await rows("SELECT token_hash, used_at, expires_at FROM one_time_token")).toEqual(before.tokens);
    expect(await rows("SELECT id, status FROM email_outbox")).toEqual(before.outbox);
    expect((await t.services.links.resolve(b.token, owner)).kind).toBe("summary");
  });

  it("otra cuenta, un token manipulado, uno vacío o uno inexistente reciben lo mismo: gone", async () => {
    const b = await booked();
    const stranger = await sessionOf(await createPatient(pool));
    expect(await t.services.links.resolve(b.token, stranger)).toEqual({ kind: "gone" });
    for (const token of [`${b.token.slice(0, -1)}x`, b.token.toUpperCase(), "", "a".repeat(200), "../../etc/passwd"]) {
      expect(await t.services.links.resolve(token, null)).toEqual({ kind: "gone" });
    }
  });

  it("un usuario que no es paciente (médico) con sesión recibe gone", async () => {
    const b = await booked();
    const { token } = await t.services.sessions.create(b.doctor.user.id, { mfaVerified: true });
    const session = await t.services.sessions.validate(token);
    expect(await t.services.links.resolve(b.token, session)).toEqual({ kind: "gone" });
  });

  it("un token vencido o usado responde gone", async () => {
    const b = await booked();
    await pool.execute("UPDATE one_time_token SET expires_at = ?", [new Date(t.clock.now().getTime() - 1000)]);
    expect(await t.services.links.resolve(b.token, null)).toEqual({ kind: "gone" });
    await pool.execute("UPDATE one_time_token SET expires_at = ?, used_at = ?", [new Date(t.clock.now().getTime() + 86_400_000), t.clock.now()]);
    expect(await t.services.links.resolve(b.token, null)).toEqual({ kind: "gone" });
  });

  it("una cita cancelada deja el enlace sin efecto (gone)", async () => {
    const b = await booked();
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?", [b.appointmentId]);
    expect(await t.services.links.resolve(b.token, await sessionOf(b.patient))).toEqual({ kind: "gone" });
  });

  it("un token cuya cita ya empezó responde gone aunque su registro no haya vencido", async () => {
    const b = await booked();
    t.clock.set(new Date("2026-06-16T16:00:00.000Z")); // 10:00 locales: la hora de la cita
    expect(await t.services.links.resolve(b.token, null)).toEqual({ kind: "gone" });
    expect((await rows("SELECT id FROM one_time_token WHERE used_at IS NULL AND expires_at > ?", [t.clock.now()])).length).toBe(1);
  });

  it("pasado el límite de cancelación, el resumen sigue pero ya no es cancelable", async () => {
    const b = await booked();
    t.clock.set(new Date("2026-06-15T16:00:01.000Z")); // 1 s después del límite (lunes 10:00)
    const resolution = await t.services.links.resolve(b.token, await sessionOf(b.patient));
    expect(resolution.kind === "summary" && resolution.summary.cancelable).toBe(false);
  });
});

describe("tokens por propósito y cita", () => {
  it("el token del recordatorio no invalida el de la confirmación (y viceversa)", async () => {
    const b = await booked();
    const reminder = await t.services.tokens.create({ purpose: "appointment_reminder", appointmentId: b.appointmentId, ttlMs: 86_400_000 });
    expect((await t.services.links.resolve(b.token, null)).kind).toBe("login_required");
    expect((await t.services.links.resolve(reminder.token, null)).kind).toBe("login_required");
    // Un recordatorio nuevo invalida el anterior del mismo propósito, no el de la confirmación.
    const second = await t.services.tokens.create({ purpose: "appointment_reminder", appointmentId: b.appointmentId, ttlMs: 86_400_000 });
    expect((await t.services.links.resolve(reminder.token, null)).kind).toBe("gone");
    expect((await t.services.links.resolve(second.token, null)).kind).toBe("login_required");
    expect((await t.services.links.resolve(b.token, null)).kind).toBe("login_required");
  });

  it("un token de otro propósito (restablecer contraseña) no sirve como enlace de cita", async () => {
    const b = await booked();
    const reset = await t.services.tokens.create({ purpose: "password_reset", userId: b.patient.user.id, ttlMs: 60_000 });
    expect(await t.services.links.resolve(reset.token, null)).toEqual({ kind: "gone" });
  });

  it("el token de una cita no abre otra", async () => {
    const b = await booked();
    const second = await reserveAsPatient(createPatientContext(b.doctor.doctorId, b.patient.user.id), { db: pool, clock: t.clock }, { startLocal: `${TUESDAY}T11:00`, patientId: b.patient.patientId, authorize: false });
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?", [second.id]);
    // El token de la primera cita sigue sirviendo y muestra la primera, no la segunda.
    const resolution = await t.services.links.resolve(b.token, await sessionOf(b.patient));
    expect(resolution.kind === "summary" && resolution.summary.appointmentId).toBe(b.appointmentId);
  });
});
