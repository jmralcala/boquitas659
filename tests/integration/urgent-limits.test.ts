import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, SiteUnavailableError, TooManyAttemptsError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext, type TenantContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { requestUrgent, type UrgentResult } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createAppointment,
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
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
const deps = { db: pool, clock };
const MX = "America/Mexico_City";
const HOUR = 3_600_000;
const MINUTE = 60_000;

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

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
  ctx: TenantContext;
  /** Pacientes de la cuenta: el titular primero y luego los adicionales. */
  ids: number[];
}

type Hours = NonNullable<NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]>;

/** Franja de urgencia del lunes de 10:00 a 15:00 (cinco espacios: 10, 11, 12, 13 y 14). */
const FIVE_SLOTS: Hours = [{ weekday: 1, startMinute: 10 * 60, endMinute: 15 * 60, kind: "urgent" }];

async function scenario(options: { hours?: Hours; dependents?: number } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { hours: options.hours ?? FIVE_SLOTS });
  const patient = await createPatient(pool);
  const ids = [patient.patientId];
  for (let index = 0; index < (options.dependents ?? 0); index += 1) ids.push(await createDependent(pool, patient.accountId, `Menor ${index + 1}`));
  return { doctor, patient, ctx: createPatientContext(doctor.doctorId, patient.user.id), ids };
}

const request = (s: Scenario, patientId = s.ids[0] ?? 0, category: "rojo" | "naranja" | "verde" = "naranja") =>
  requestUrgent(s.ctx, deps, { patientId, category, authorize: true });

const scheduledId = (result: UrgentResult): number => {
  if (result.kind !== "scheduled") throw new Error("se esperaba una cita");
  return result.id;
};

describe("una urgencia activa por paciente", () => {
  it("una urgencia vigente impide otra del mismo paciente (409 urgent_active) pero no la de otro paciente de la cuenta", async () => {
    const s = await scenario({ dependents: 1 });
    await request(s);
    clock.advance(3 * MINUTE); // fuera de la ventana de «doble envío»
    const error = await request(s).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("urgent_active");
    expect((await request(s, s.ids[1])).kind).toBe("scheduled");
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(2);
  });

  it("una urgencia cancelada o ya iniciada deja de estar activa", async () => {
    const s = await scenario();
    const first = scheduledId(await request(s));
    clock.advance(3 * MINUTE);
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_by_role = 'patient', cancelled_at = ? WHERE id = ?", [s.patient.user.id, clock.now(), first]);
    const second = scheduledId(await request(s));
    expect(second).not.toBe(first);
    // Cuando la segunda ya empezó (pasó su hora), se puede pedir otra.
    const [row] = await rows("SELECT start_utc FROM appointment WHERE id = ?", [second]);
    clock.set(new Date((row?.start_utc as Date).getTime() + MINUTE));
    expect((await request(s)).kind).toBe("scheduled");
  });

  it("una cita convencional vigente del paciente no cuenta como urgencia activa", async () => {
    const s = await scenario({ hours: [...FIVE_SLOTS, { weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60 }] });
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.ids[0] ?? 0, startUtc: localAt(MX, "2026-06-16", "09:00"), createdByUserId: s.patient.user.id, createdByRole: "patient" });
    expect((await request(s)).kind).toBe("scheduled");
  });
});

describe("3 solicitudes por cuenta cada 24 horas", () => {
  it("cuenta también las que terminaron sin espacio; la cuarta lanza 429 con la espera desde la más antigua", async () => {
    const s = await scenario({ hours: [], dependents: 2 });
    const first = clock.now();
    for (const id of s.ids) {
      expect((await request(s, id)).kind).toBe("no_space");
      clock.advance(10 * MINUTE);
    }
    const error = await request(s).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyAttemptsError);
    const wait = (error as TooManyAttemptsError).retryAfterMs;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(24 * HOUR);
    expect(Math.abs(first.getTime() + 24 * HOUR - (clock.now().getTime() + wait))).toBeLessThan(1000);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(3);
  });

  it("el borde de 24 h es exacto: justo a las 24 h todavía cuenta; un milisegundo después ya no", async () => {
    const s = await scenario({ hours: [] });
    const first = clock.now();
    await request(s);
    clock.advance(MINUTE);
    await request(s);
    clock.advance(MINUTE);
    await request(s);
    clock.set(new Date(first.getTime() + 24 * HOUR));
    await expect(request(s)).rejects.toBeInstanceOf(TooManyAttemptsError);
    clock.set(new Date(first.getTime() + 24 * HOUR + 1));
    expect((await request(s)).kind).toBe("no_space");
  });

  it("combina solicitudes agendadas y sin espacio: una agendada y dos sin espacio llenan el cupo", async () => {
    const s = await scenario({ hours: [{ weekday: 1, startMinute: 10 * 60, endMinute: 10 * 60 + 45, kind: "urgent" }], dependents: 2 });
    expect((await request(s, s.ids[0])).kind).toBe("scheduled");
    expect((await request(s, s.ids[1])).kind).toBe("no_space");
    expect((await request(s, s.ids[2])).kind).toBe("no_space");
    await expect(request(s, s.ids[1])).rejects.toBeInstanceOf(TooManyAttemptsError);
  });

  it("el límite es por cuenta y entre consultorios; otra cuenta no se ve afectada", async () => {
    const s = await scenario({ hours: [] });
    const other = await createDoctor(pool);
    await createPublishedSite(pool, other, { hours: [] });
    const otherCtx = createPatientContext(other.doctorId, s.patient.user.id);
    await request(s);
    await requestUrgent(otherCtx, deps, { patientId: s.ids[0] ?? 0, category: "naranja", authorize: true });
    await request(s);
    await expect(requestUrgent(otherCtx, deps, { patientId: s.ids[0] ?? 0, category: "naranja", authorize: true })).rejects.toBeInstanceOf(TooManyAttemptsError);
    const stranger = await createPatient(pool);
    const strangerResult = await requestUrgent(createPatientContext(s.doctor.doctorId, stranger.user.id), deps, { patientId: stranger.patientId, category: "naranja", authorize: true });
    expect(strangerResult.kind).toBe("no_space");
  });

  it("una ráfaga simultánea de 5 solicitudes de la misma cuenta deja pasar exactamente 3", async () => {
    const s = await scenario({ dependents: 4 });
    const results = await Promise.allSettled(s.ids.map((id) => request(s, id)));
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((result) => result.reason instanceof TooManyAttemptsError)).toBe(true);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(3);
  });
});

describe("lo rechazado no cuenta", () => {
  it("la validación, el paciente ajeno, el consultorio sin servicio y la urgencia ya activa no dejan fila de solicitud", async () => {
    const s = await scenario({ dependents: 1 });
    // Sin la casilla de autorización.
    await expect(requestUrgent(s.ctx, deps, { patientId: s.ids[0] ?? 0, category: "rojo", authorize: false })).rejects.toBeInstanceOf(ValidationError);
    // Paciente de otra cuenta.
    const stranger = await createPatient(pool);
    await expect(request(s, stranger.patientId)).rejects.toBeInstanceOf(NotFoundError);
    // Urgencia ya activa.
    await request(s);
    clock.advance(3 * MINUTE);
    const before = (await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).length;
    await expect(request(s)).rejects.toBeInstanceOf(ConflictError);
    // Consultorio sin servicio.
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [s.doctor.doctorId]);
    await expect(request(s, s.ids[1])).rejects.toBeInstanceOf(SiteUnavailableError);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(before);
  });
});

describe("doble envío", () => {
  it("una segunda petición igual de la misma cuenta devuelve la cita ya creada: sin otra cita, otra autorización ni otra fila", async () => {
    const s = await scenario();
    const first = await request(s);
    const second = await request(s);
    expect(first.kind).toBe("scheduled");
    expect(second).toMatchObject({ kind: "scheduled", created: false });
    if (first.kind === "scheduled" && second.kind === "scheduled") expect(second.id).toBe(first.id);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(1);
  });

  it("el doble envío no cuenta dos veces para el límite de 24 h", async () => {
    const s = await scenario({ dependents: 2 });
    await request(s);
    await request(s); // doble envío
    expect((await request(s, s.ids[1])).kind).toBe("scheduled");
    expect((await request(s, s.ids[2])).kind).toBe("scheduled");
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'urgent_requested'")).toHaveLength(3);
  });

  it("pasados 2 minutos ya no es doble envío: es una segunda urgencia activa", async () => {
    const s = await scenario();
    await request(s);
    clock.advance(2 * MINUTE + 1);
    await expect(request(s)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("las urgencias no consumen los cupos de la reserva convencional (y viceversa)", () => {
  const regularHours: Hours = [...FIVE_SLOTS, { weekday: 2, startMinute: 9 * 60, endMinute: 14 * 60 }]; // martes 9:00–13:00
  const times = ["09:00", "10:00", "11:00", "12:00", "13:00"];

  it("3 urgencias no restan de las 5 reservas convencionales por hora", async () => {
    const s = await scenario({ hours: regularHours, dependents: 4 });
    for (const id of s.ids.slice(0, 3)) expect((await request(s, id)).kind).toBe("scheduled");
    for (const [index, time] of times.entries()) {
      const result = await reserveAsPatient(s.ctx, deps, { startLocal: `2026-06-16T${time}`, patientId: s.ids[index] ?? 0, authorize: true });
      expect(result.created, time).toBe(true);
    }
  });

  it("5 reservas convencionales no restan de las 3 solicitudes de urgencia", async () => {
    const s = await scenario({ hours: regularHours, dependents: 4 });
    for (const [index, time] of times.entries()) {
      const result = await reserveAsPatient(s.ctx, deps, { startLocal: `2026-06-16T${time}`, patientId: s.ids[index] ?? 0, authorize: true });
      expect(result.created, time).toBe(true);
    }
    for (const id of s.ids.slice(0, 3)) expect((await request(s, id)).kind).toBe("scheduled");
    await expect(request(s, s.ids[3])).rejects.toBeInstanceOf(TooManyAttemptsError); // la cuarta solicitud sí topa con su propio límite
  });

  it("un paciente con una cita convencional vigente puede pedir una urgencia, y viceversa", async () => {
    const s = await scenario({ hours: regularHours });
    await reserveAsPatient(s.ctx, deps, { startLocal: "2026-06-16T09:00", patientId: s.ids[0] ?? 0, authorize: true });
    expect((await request(s)).kind).toBe("scheduled");
    await expect(reserveAsPatient(s.ctx, deps, { startLocal: "2026-06-16T10:00", patientId: s.ids[0] ?? 0, authorize: true })).resolves.toMatchObject({ created: true });
  });
});
