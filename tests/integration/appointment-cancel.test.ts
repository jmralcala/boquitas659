import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type TenantContext } from "../../src/lib/tenant.js";
import { getDay } from "../../src/modules/calendar/agenda-service.js";
import { cancelAppointment, createAppointment } from "../../src/modules/calendar/appointment-service.js";
import {
  clearTables,
  createAppointment as insertAppointment,
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
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 locales
const deps = { db: pool, clock, ticketSecret: "s".repeat(40) };
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

async function scenario(): Promise<Scenario> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: "Paciente Uno" });
  await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
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

describe("cancelAppointment", () => {
  it("cancela una cita futura: queda cancelled con quién y cuándo, y el espacio vuelve a estar libre", async () => {
    const s = await scenario();
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    expect((await getDay(s.ctx, pool, TUESDAY, clock.now())).slots.find((slot) => slot.appointmentId === id)?.state).toBe("booked");

    await cancelAppointment(s.ctx, deps, id);

    const [row] = await rows("SELECT status, cancelled_by_user_id, cancelled_by_role, cancelled_at FROM appointment WHERE id = ?", [id]);
    expect(row).toMatchObject({ status: "cancelled", cancelled_by_user_id: s.doctor.user.id, cancelled_by_role: "doctor" });
    expect((row?.cancelled_at as Date).toISOString()).toBe(clock.now().toISOString());
    const day = await getDay(s.ctx, pool, TUESDAY, clock.now());
    expect(day.slots.find((slot) => slot.startUtc.getTime() === localAt(MX, TUESDAY, "10:00").getTime())?.state).toBe("free");
    expect(day.appointments).toEqual([]);
  });

  it("encola appointment_cancelled en la misma transacción y registra la acción", async () => {
    const s = await scenario();
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await cancelAppointment(s.ctx, deps, id);
    const outbox = await rows("SELECT template, to_email, payload_ref FROM email_outbox");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ template: "appointment_cancelled", to_email: s.accountEmail });
    expect(JSON.parse(String(outbox[0]?.payload_ref))).toEqual({ appointmentId: id });
    expect(await rows("SELECT actor_user_id, actor_role, action, appointment_id, outcome FROM calendar_action_log")).toEqual([
      { actor_user_id: s.doctor.user.id, actor_role: "doctor", action: "appointment_cancelled", appointment_id: id, outcome: "ok" },
    ]);
  });

  it("la recepción puede cancelar y queda a su nombre", async () => {
    const s = await scenario();
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, s.doctor.doctorId, person.id);
    const ctx = createTenantContext(s.doctor.doctorId, { kind: "reception", userId: person.id });
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await cancelAppointment(ctx, deps, id);
    expect(await rows("SELECT cancelled_by_user_id, cancelled_by_role FROM appointment WHERE id = ?", [id])).toEqual([
      { cancelled_by_user_id: person.id, cancelled_by_role: "reception" },
    ]);
  });

  it("cancelar otra vez una cita cancelada es un conflicto y no repite el aviso", async () => {
    const s = await scenario();
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await cancelAppointment(s.ctx, deps, id);
    await expect(cancelAppointment(s.ctx, deps, id)).rejects.toBeInstanceOf(ConflictError);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_cancelled'")).toHaveLength(1);
  });

  it("una cita cuya hora ya pasó no se puede cancelar", async () => {
    const s = await scenario();
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    clock.set(localAt(MX, TUESDAY, "10:45")); // justo cuando termina
    await expect(cancelAppointment(s.ctx, deps, id)).rejects.toBeInstanceOf(ConflictError);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [id])).toEqual([{ status: "booked" }]);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("una cita que está en curso (ya empezó, no terminó) todavía se puede cancelar", async () => {
    const s = await scenario();
    const id = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    clock.set(localAt(MX, TUESDAY, "10:20"));
    await expect(cancelAppointment(s.ctx, deps, id)).resolves.toBeUndefined();
  });

  it("una cita de otro médico se trata como inexistente y no cambia", async () => {
    const a = await scenario();
    const b = await scenario();
    const id = await insertAppointment(pool, { doctorId: a.doctor.doctorId, patientId: a.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await expect(cancelAppointment(b.ctx, deps, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelAppointment(b.ctx, deps, 9_999_999)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [id])).toEqual([{ status: "booked" }]);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });

  it("tras cancelar se puede agendar otra cita en el mismo espacio", async () => {
    const s = await scenario();
    const created = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    await cancelAppointment(s.ctx, deps, created.id);
    const again = await createAppointment(s.ctx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patientId });
    expect(again.id).not.toBe(created.id);
    expect(await rows("SELECT status FROM appointment ORDER BY id")).toEqual([{ status: "cancelled" }, { status: "booked" }]);
  });

  it("no toca otras citas del mismo médico", async () => {
    const s = await scenario();
    const first = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    const second = await insertAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patientId, startUtc: localAt(MX, TUESDAY, "11:00") });
    await cancelAppointment(s.ctx, deps, first);
    expect(await rows("SELECT id, status FROM appointment ORDER BY id")).toEqual([
      { id: first, status: "cancelled" },
      { id: second, status: "booked" },
    ]);
  });
});
