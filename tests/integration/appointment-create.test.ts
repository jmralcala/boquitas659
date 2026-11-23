import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type TenantContext } from "../../src/lib/tenant.js";
import { createAppointment } from "../../src/modules/calendar/appointment-service.js";
import { issueTicket } from "../../src/modules/calendar/patient-picker.js";
import {
  clearTables,
  createAppointment as insertAppointment,
  createBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createMembership,
  createPatient,
  createTestPool,
  createUser,
  linkPatientToDoctor,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
const SECRET = "s".repeat(40);
const deps = { db: pool, clock, ticketSecret: SECRET };
const MX = "America/Mexico_City";
const TUESDAY = "2026-06-16";

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

interface Scenario {
  doctor: CreatedDoctor;
  ctx: TenantContext;
  patientId: number;
  accountEmail: string;
}

async function scenario(options: { settings?: Parameters<typeof createCalendarSettings>[2]; linked?: boolean } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId, options.settings);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { email: `paciente${doctor.doctorId}@example.com`, fullName: "Paciente Uno" });
  if (options.linked !== false) await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
  return {
    doctor,
    ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }),
    patientId: patient.patientId,
    accountEmail: patient.user.email,
  };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("createAppointment: caso feliz", () => {
  it("crea la cita con inicio y fin UTC según la duración vigente y deja el espacio ocupado", async () => {
    const s = await scenario();
    const result = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    expect(result.startUtc.toISOString()).toBe("2026-06-16T16:00:00.000Z");
    expect(result.endUtc.toISOString()).toBe("2026-06-16T16:45:00.000Z");
    const [row] = await rows("SELECT * FROM appointment WHERE id = ?", [result.id]);
    expect(row).toMatchObject({ doctor_id: s.doctor.doctorId, patient_id: s.patientId, status: "booked", kind: "regular", created_by_user_id: s.doctor.user.id, created_by_role: "doctor" });
    expect((row?.created_at as Date).toISOString()).toBe(clock.now().toISOString());
  });

  it("una duración distinta cambia el fin (30 min, intervalo 0)", async () => {
    const s = await scenario({ settings: { slotMinutes: 30, gapMinutes: 0 } });
    const result = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:30`, patientId: s.patientId });
    expect(result.endUtc.getTime() - result.startUtc.getTime()).toBe(30 * 60_000);
  });

  it("usa la zona horaria del consultorio para interpretar la hora local", async () => {
    const doctor = await createDoctor(pool);
    await createCalendarSettings(pool, doctor.doctorId, { timezone: "America/Tijuana" });
    await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
    const ctx = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
    const result = await createAppointment(ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: patient.patientId });
    expect(result.startUtc.toISOString()).toBe("2026-06-16T17:00:00.000Z"); // Tijuana en verano: UTC−7
  });

  it("registra la acción appointment_created con quién y el id de la cita", async () => {
    const s = await scenario();
    const result = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    expect(await rows("SELECT doctor_id, actor_user_id, actor_role, action, appointment_id, outcome FROM calendar_action_log")).toEqual([
      { doctor_id: s.doctor.doctorId, actor_user_id: s.doctor.user.id, actor_role: "doctor", action: "appointment_created", appointment_id: result.id, outcome: "ok" },
    ]);
  });

  it("la recepción puede agendar y la cita queda a su nombre", async () => {
    const s = await scenario();
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, s.doctor.doctorId, person.id);
    const ctx = createTenantContext(s.doctor.doctorId, { kind: "reception", userId: person.id });
    const result = await createAppointment(ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    const [row] = await rows("SELECT created_by_user_id, created_by_role FROM appointment WHERE id = ?", [result.id]);
    expect(row).toEqual({ created_by_user_id: person.id, created_by_role: "reception" });
  });
});

describe("createAppointment: vínculo médico-paciente", () => {
  it("crea el vínculo si el paciente aún no estaba vinculado y viene con boleto válido", async () => {
    const s = await scenario({ linked: false });
    const ticket = issueTicket(SECRET, s.ctx, s.patientId, clock.now());
    await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId, ticket });
    expect(await rows("SELECT doctor_id, patient_id FROM doctor_patient")).toEqual([{ doctor_id: s.doctor.doctorId, patient_id: s.patientId }]);
  });

  it("sin boleto, un paciente no vinculado es inalcanzable (404) y no queda nada", async () => {
    const s = await scenario({ linked: false });
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT * FROM appointment")).toEqual([]);
    expect(await rows("SELECT * FROM doctor_patient")).toEqual([]);
    expect(await rows("SELECT * FROM email_outbox")).toEqual([]);
  });

  it("un boleto de otro médico, vencido o de otro paciente no sirve", async () => {
    const s = await scenario({ linked: false });
    const other = await scenario({ linked: false });
    const foreign = issueTicket(SECRET, other.ctx, s.patientId, clock.now());
    const expired = issueTicket(SECRET, s.ctx, s.patientId, new Date(clock.now().getTime() - 16 * 60_000));
    const wrongPatient = issueTicket(SECRET, s.ctx, s.patientId + 1, clock.now());
    for (const ticket of [foreign, expired, wrongPatient, "basura"]) {
      await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId, ticket })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await rows("SELECT * FROM doctor_patient")).toEqual([]);
  });

  it("un paciente vinculado solo con otro médico no es alcanzable sin boleto", async () => {
    const s = await scenario();
    const other = await scenario({ linked: false });
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, other.doctor.doctorId, patient.patientId);
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: patient.patientId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("un boleto válido para un paciente inexistente da 404 y no deja vínculo", async () => {
    const s = await scenario();
    const ticket = issueTicket(SECRET, s.ctx, 987_654, clock.now());
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: 987_654, ticket })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT * FROM appointment")).toEqual([]);
  });
});

describe("createAppointment: correo", () => {
  it("encola appointment_created para el correo de la cuenta, solo con el id de la cita", async () => {
    const s = await scenario();
    const result = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    const outbox = await rows("SELECT template, to_email, payload_ref, status FROM email_outbox");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ template: "appointment_created", to_email: s.accountEmail, status: "queued" });
    expect(JSON.parse(String(outbox[0]?.payload_ref))).toEqual({ appointmentId: result.id });
  });

  it("para un menor, el correo va a la cuenta del tutor y la cita es del menor", async () => {
    const s = await scenario();
    const [minor] = await pool.execute<import("mysql2/promise").ResultSetHeader>(
      `INSERT INTO patient (account_id, full_name, birth_date, is_minor_dependent)
       SELECT account_id, 'Menor de Prueba', '2018-03-01', 1 FROM patient WHERE id = ?`,
      [s.patientId],
    );
    await linkPatientToDoctor(pool, s.doctor.doctorId, minor.insertId);
    const result = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: minor.insertId });
    expect(await rows("SELECT patient_id FROM appointment WHERE id = ?", [result.id])).toEqual([{ patient_id: minor.insertId }]);
    expect(await rows("SELECT to_email FROM email_outbox")).toEqual([{ to_email: s.accountEmail }]);
  });

  it("si la cita se rechaza no queda ningún correo en cola", async () => {
    const s = await scenario();
    await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
    expect(await rows("SELECT * FROM email_outbox")).toHaveLength(1);
    expect(await rows("SELECT * FROM appointment")).toHaveLength(1);
  });
});

describe("createAppointment: espacios no válidos", () => {
  it("rechaza un espacio ocupado (409)", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("una cita cancelada no ocupa el espacio", async () => {
    const s = await scenario();
    await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00"), status: "cancelled" });
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).resolves.toBeDefined();
  });

  it("rechaza un espacio bloqueado (409), incluso si el bloqueo solo lo cubre en parte", async () => {
    const s = await scenario();
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "10:30"), endUtc: localAt(MX, TUESDAY, "12:00") });
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
    expect(await rows("SELECT * FROM appointment")).toEqual([]);
  });

  it("rechaza un espacio pasado o que ya empezó (409)", async () => {
    const s = await scenario();
    clock.set(new Date("2026-06-16T16:00:00.000Z")); // martes 10:00 locales
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
    await expect(createAppointment(s.ctx, deps, { startLocal: "2026-06-15T10:00", patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
  });

  it.each([
    ["fuera de la franja", `${TUESDAY}T20:00`],
    ["en el descanso entre franjas", `${TUESDAY}T14:00`],
    ["desfasado respecto a la cuadrícula", `${TUESDAY}T10:30`],
    ["en un día sin horario (domingo)", "2026-06-21T10:00"],
    ["con el último espacio incompleto de la franja", `${TUESDAY}T13:30`],
  ])("rechaza un inicio %s (400)", async (_name, startLocal) => {
    const s = await scenario();
    await expect(createAppointment(s.ctx, deps, { startLocal, patientId: s.patientId })).rejects.toBeInstanceOf(ValidationError);
    expect(await rows("SELECT * FROM appointment")).toEqual([]);
  });

  it.each([["2026-06-16"], ["2026-06-16 10:00"], ["16/06/2026 10:00"], ["2026-06-16T25:00"], ["2026-02-30T10:00"], [""]])(
    "rechaza un inicio mal formado %s (400)",
    async (startLocal) => {
      const s = await scenario();
      await expect(createAppointment(s.ctx, deps, { startLocal, patientId: s.patientId })).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it("rechaza más de 730 días hacia adelante (400) y acepta justo 730", async () => {
    const s = await scenario();
    // Hoy local es 2026-06-15; +730 días = 2028-06-14 (miércoles); +731 = 2028-06-15 (jueves). Ambos son días hábiles.
    await expect(createAppointment(s.ctx, deps, { startLocal: "2028-06-15T10:00", patientId: s.patientId })).rejects.toBeInstanceOf(ValidationError);
    await expect(createAppointment(s.ctx, deps, { startLocal: "2028-06-14T10:00", patientId: s.patientId })).resolves.toBeDefined();
  });

  it("rechaza una cita que se solapa con otra aunque empiece a otra hora (tras reducir la duración)", async () => {
    const s = await scenario({ settings: { slotMinutes: 30, gapMinutes: 0 } });
    // Cita antigua de 45 min a las 10:00 (10:00–10:45); el espacio nuevo de las 10:30 (10:30–11:00) se solapa.
    await insertAppointment(pool, {
      doctorId: s.doctor.doctorId,
      patientId: s.patientId,
      startUtc: localAt(MX, TUESDAY, "10:00"),
      endUtc: localAt(MX, TUESDAY, "10:45"),
    });
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:30`, patientId: s.patientId })).rejects.toBeInstanceOf(ConflictError);
    await expect(createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T11:00`, patientId: s.patientId })).resolves.toBeDefined();
  });
});

describe("createAppointment: el personal no pasa por las anticipaciones del paciente", () => {
  it("puede agendar dentro de la anticipación mínima (en 1 hora)", async () => {
    const s = await scenario({ settings: { minNoticeMinutes: 24 * 60 } });
    // Lunes 9:00 local, una hora después de «ahora» (8:00): un paciente no podría, el personal sí.
    await expect(createAppointment(s.ctx, deps, { startLocal: "2026-06-15T09:00", patientId: s.patientId })).resolves.toBeDefined();
  });

  it("puede agendar más allá de la anticipación máxima", async () => {
    const s = await scenario({ settings: { maxAdvanceDays: 1 } });
    await expect(createAppointment(s.ctx, deps, { startLocal: "2026-07-07T10:00", patientId: s.patientId })).resolves.toBeDefined();
  });
});

describe("createAppointment: aislamiento", () => {
  it("la cita siempre es del médico del contexto", async () => {
    const a = await scenario();
    const b = await scenario();
    const result = await createAppointment(a.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: a.patientId });
    expect(await rows("SELECT doctor_id FROM appointment WHERE id = ?", [result.id])).toEqual([{ doctor_id: a.doctor.doctorId }]);
    expect(await rows("SELECT * FROM appointment WHERE doctor_id = ?", [b.doctor.doctorId])).toEqual([]);
  });

  it("el mismo inicio puede estar ocupado para un médico y libre para otro", async () => {
    const a = await scenario();
    const b = await scenario();
    await createAppointment(a.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: a.patientId });
    await expect(createAppointment(b.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: b.patientId })).resolves.toBeDefined();
  });
});
