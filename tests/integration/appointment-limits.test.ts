import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TooManyAttemptsError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext, type TenantContext } from "../../src/lib/tenant.js";
import { ACTION_LIMITS, logCalendarAction } from "../../src/modules/calendar/action-log.js";
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
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

// Límite de crear y cancelar citas: 60 por hora por persona y 5 por hora por persona y paciente.
const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z"));
const deps = { db: pool, clock, ticketSecret: "s".repeat(40) };
const MX = "America/Mexico_City";

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

interface Practice {
  doctorId: number;
  ctx: TenantContext;
  patientIds: number[];
}

async function practice(patients = 8): Promise<Practice> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId, { slotMinutes: 15, gapMinutes: 0 });
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patientIds: number[] = [];
  for (let index = 0; index < patients; index += 1) {
    const patient = await createPatient(pool);
    await linkPatientToDoctor(pool, doctor.doctorId, patient.patientId);
    patientIds.push(patient.patientId);
  }
  return { doctorId: doctor.doctorId, ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), patientIds };
}

/** Horas del martes 16 de junio de 2026 (franja 9:00–14:00 con espacios de 15 min). */
function slot(index: number): string {
  const minutes = 9 * 60 + index * 15;
  return `2026-06-16T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

/** Simula N acciones previas de la persona en la última hora sin pasar por el servicio. */
async function priorActions(ctx: TenantContext, count: number, action: "appointment_created" | "appointment_cancelled" = "appointment_created"): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await logCalendarAction(ctx, pool, { action, outcome: "ok", at: new Date(clock.now().getTime() - 30 * 60_000 + index) });
  }
}

describe("límite por persona: 60 acciones sobre citas por hora", () => {
  it("la acción 61 se rechaza con 429 y espera calculada; las 60 anteriores pasan", async () => {
    const s = await practice();
    await priorActions(s.ctx, 59); // la creación de esta prueba es la número 60
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(0), patientId: s.patientIds[0] ?? 0 })).resolves.toBeDefined();
    const error = await createAppointment(s.ctx, deps, { startLocal: slot(1), patientId: s.patientIds[1] ?? 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyAttemptsError);
    expect((error as TooManyAttemptsError).retryAfterMs).toBeGreaterThan(0);
    expect((error as TooManyAttemptsError).retryAfterMs).toBeLessThanOrEqual(ACTION_LIMITS.windowMs);
    // El rechazo no deja cita, correo ni fila de registro.
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_created'")).toHaveLength(60);
  });

  it("cancelar también cuenta y también se limita", async () => {
    const s = await practice();
    const id = await insertAppointment(pool, { doctorId: s.doctorId, patientId: s.patientIds[0] ?? 0, startUtc: localAt(MX, "2026-06-16", "10:00") });
    await priorActions(s.ctx, 30, "appointment_created");
    await priorActions(s.ctx, 30, "appointment_cancelled");
    await expect(cancelAppointment(s.ctx, deps, id)).rejects.toBeInstanceOf(TooManyAttemptsError);
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [id])).toEqual([{ status: "booked" }]);
  });

  it("pasada la hora vuelve a permitirse", async () => {
    const s = await practice();
    await priorActions(s.ctx, 60);
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(0), patientId: s.patientIds[0] ?? 0 })).rejects.toBeInstanceOf(TooManyAttemptsError);
    clock.advance(ACTION_LIMITS.windowMs + 60_000);
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(0), patientId: s.patientIds[0] ?? 0 })).resolves.toBeDefined();
  });

  it("es por persona: otra persona del mismo consultorio no se ve afectada", async () => {
    const s = await practice();
    await priorActions(s.ctx, 60);
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, s.doctorId, person.id);
    const receptionCtx = createTenantContext(s.doctorId, { kind: "reception", userId: person.id });
    await expect(createAppointment(receptionCtx, deps, { startLocal: slot(0), patientId: s.patientIds[0] ?? 0 })).resolves.toBeDefined();
  });

  it("cuenta las acciones de la persona con TODOS sus médicos (no se multiplica al cambiar de consultorio)", async () => {
    const a = await practice();
    const b = await practice();
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, a.doctorId, person.id);
    await createMembership(pool, b.doctorId, person.id);
    const withA = createTenantContext(a.doctorId, { kind: "reception", userId: person.id });
    const withB = createTenantContext(b.doctorId, { kind: "reception", userId: person.id });
    await priorActions(withA, 60);
    await expect(createAppointment(withB, deps, { startLocal: slot(0), patientId: b.patientIds[0] ?? 0 })).rejects.toBeInstanceOf(TooManyAttemptsError);
  });

  it("las acciones de hace más de una hora no cuentan", async () => {
    const s = await practice();
    for (let index = 0; index < 60; index += 1) {
      await logCalendarAction(s.ctx, pool, { action: "appointment_created", outcome: "ok", at: new Date(clock.now().getTime() - 2 * 3_600_000) });
    }
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(0), patientId: s.patientIds[0] ?? 0 })).resolves.toBeDefined();
  });

  it("otras acciones (bloqueos, búsquedas, configuración) no cuentan para este límite", async () => {
    const s = await practice();
    for (const action of ["block_created", "block_removed", "block_rejected", "patient_lookup", "settings_updated"] as const) {
      for (let index = 0; index < 20; index += 1) await logCalendarAction(s.ctx, pool, { action, outcome: "ok", at: clock.now() });
    }
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(0), patientId: s.patientIds[0] ?? 0 })).resolves.toBeDefined();
  });
});

describe("límite por paciente: 5 citas creadas por hora por persona", () => {
  it("la sexta cita para el mismo paciente se rechaza; otros pacientes siguen permitidos", async () => {
    const s = await practice();
    const patient = s.patientIds[0] ?? 0;
    for (let index = 0; index < 5; index += 1) {
      await createAppointment(s.ctx, deps, { startLocal: slot(index), patientId: patient });
    }
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(5), patientId: patient })).rejects.toBeInstanceOf(TooManyAttemptsError);
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(5), patientId: s.patientIds[1] ?? 0 })).resolves.toBeDefined();
    expect(await rows("SELECT id FROM appointment WHERE patient_id = ?", [patient])).toHaveLength(5);
  });

  it("cancelar y volver a agendar al mismo paciente sigue contando las creaciones", async () => {
    const s = await practice();
    const patient = s.patientIds[0] ?? 0;
    for (let index = 0; index < 5; index += 1) {
      const created = await createAppointment(s.ctx, deps, { startLocal: slot(index), patientId: patient });
      await cancelAppointment(s.ctx, deps, created.id);
    }
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(6), patientId: patient })).rejects.toBeInstanceOf(TooManyAttemptsError);
  });

  it("es por persona: otra persona puede agendar a ese paciente", async () => {
    const s = await practice();
    const patient = s.patientIds[0] ?? 0;
    for (let index = 0; index < 5; index += 1) await createAppointment(s.ctx, deps, { startLocal: slot(index), patientId: patient });
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, s.doctorId, person.id);
    const receptionCtx = createTenantContext(s.doctorId, { kind: "reception", userId: person.id });
    await expect(createAppointment(receptionCtx, deps, { startLocal: slot(5), patientId: patient })).resolves.toBeDefined();
  });

  it("pasada la hora vuelve a permitirse", async () => {
    const s = await practice();
    const patient = s.patientIds[0] ?? 0;
    for (let index = 0; index < 5; index += 1) await createAppointment(s.ctx, deps, { startLocal: slot(index), patientId: patient });
    clock.advance(ACTION_LIMITS.windowMs + 60_000);
    await expect(createAppointment(s.ctx, deps, { startLocal: slot(6), patientId: patient })).resolves.toBeDefined();
  });

  it("una ráfaga de 12 creaciones simultáneas para el mismo paciente deja pasar exactamente 5", async () => {
    const s = await practice();
    const patient = s.patientIds[0] ?? 0;
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_unused, index) => createAppointment(s.ctx, deps, { startLocal: slot(index), patientId: patient })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected.every((result) => result.reason instanceof TooManyAttemptsError)).toBe(true);
  });
});
