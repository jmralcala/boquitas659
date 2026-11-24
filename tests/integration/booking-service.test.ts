import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, SiteUnavailableError, TooManyAttemptsError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext, type TenantContext } from "../../src/lib/tenant.js";
import { revokeAccountLinks } from "../../src/modules/patients/patient-repository.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import {
  clearTables,
  createAppointment,
  createBlock,
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
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
const deps = { db: pool, clock };
const MX = "America/Mexico_City";
const TUESDAY = "2026-06-16";

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

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
  ctx: TenantContext;
}

async function scenario(options: { settings?: NonNullable<Parameters<typeof createPublishedSite>[2]>["settings"] } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, options.settings ? { settings: options.settings } : {});
  const patient = await createPatient(pool);
  return { doctor, patient, ctx: createPatientContext(doctor.doctorId, patient.user.id) };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const reserve = (s: Scenario, startLocal: string, extra: { patientId?: number; authorize?: boolean } = {}) =>
  reserveAsPatient(s.ctx, deps, { startLocal, patientId: extra.patientId ?? s.patient.patientId, authorize: extra.authorize ?? true });

describe("reserveAsPatient: caso feliz", () => {
  it("crea la cita agendada a nombre del paciente, el vínculo, la autorización y la acción registrada", async () => {
    const s = await scenario();
    const result = await reserve(s, `${TUESDAY}T10:00`);
    expect(result.created).toBe(true);
    expect(result.startUtc.toISOString()).toBe("2026-06-16T16:00:00.000Z");
    expect(result.endUtc.toISOString()).toBe("2026-06-16T16:45:00.000Z");

    const [appointment] = await rows("SELECT * FROM appointment WHERE id = ?", [result.id]);
    expect(appointment).toMatchObject({
      doctor_id: s.doctor.doctorId,
      patient_id: s.patient.patientId,
      status: "booked",
      kind: "regular",
      created_by_user_id: s.patient.user.id,
      created_by_role: "patient",
    });
    const [link] = await rows("SELECT origin, created_by_user_id, revoked_at FROM doctor_patient WHERE doctor_id = ? AND patient_id = ?", [s.doctor.doctorId, s.patient.patientId]);
    expect(link).toMatchObject({ origin: "patient", created_by_user_id: s.patient.user.id, revoked_at: null });
    expect(await rows("SELECT id FROM data_authorization WHERE account_id = ? AND doctor_id = ?", [s.patient.accountId, s.doctor.doctorId])).toHaveLength(1);
    const actions = await rows("SELECT action, actor_role, appointment_id FROM calendar_action_log ORDER BY id");
    expect(actions.map((row) => row.action)).toEqual(["data_authorized", "appointment_created"]);
    expect(actions[1]).toMatchObject({ actor_role: "patient", appointment_id: result.id });
  });

  it("la segunda reserva con el consultorio no vuelve a pedir ni a registrar la autorización", async () => {
    const s = await scenario();
    await reserve(s, `${TUESDAY}T10:00`);
    await reserve(s, `${TUESDAY}T11:00`, { authorize: false });
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    expect(await rows("SELECT id FROM appointment WHERE status = 'booked'")).toHaveLength(2);
  });
});

describe("reserveAsPatient: autorización de datos", () => {
  it("sin la casilla y sin autorización activa se rechaza con el campo `autorizo` y no se crea nada", async () => {
    const s = await scenario();
    const error = await reserve(s, `${TUESDAY}T10:00`, { authorize: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(Object.keys((error as ValidationError).fields ?? {})).toEqual(["autorizo"]);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
  });

  it("con una autorización activa no pide la casilla y no registra otra", async () => {
    const s = await scenario();
    await createDataAuthorization(pool, { accountId: s.patient.accountId, doctorId: s.doctor.doctorId, userId: s.patient.user.id, at: new Date("2026-06-01T00:00:00Z") });
    await reserve(s, `${TUESDAY}T10:00`, { authorize: false });
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'data_authorized'")).toEqual([]);
  });

  it("la cita de un menor queda a nombre del menor con la autorización del tutor", async () => {
    const s = await scenario();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Prueba");
    const result = await reserve(s, `${TUESDAY}T10:00`, { patientId: minorId });
    const [appointment] = await rows("SELECT patient_id, created_by_user_id FROM appointment WHERE id = ?", [result.id]);
    expect(appointment).toMatchObject({ patient_id: minorId, created_by_user_id: s.patient.user.id });
    expect((await rows("SELECT given_by_user_id FROM data_authorization"))[0]?.given_by_user_id).toBe(s.patient.user.id);
    expect(await rows("SELECT patient_id FROM doctor_patient WHERE doctor_id = ?", [s.doctor.doctorId])).toEqual([{ patient_id: minorId }]);
  });

  it("reactiva un vínculo revocado y exige una nueva autorización", async () => {
    const s = await scenario();
    await reserve(s, `${TUESDAY}T10:00`);
    await revokeAccountLinks(s.ctx, pool, s.patient.accountId, new Date("2026-06-15T15:00:00.000Z"));
    clock.set(new Date("2026-06-15T16:00:00.000Z"));
    await expect(reserve(s, `${TUESDAY}T11:00`, { authorize: false })).rejects.toBeInstanceOf(ValidationError);
    expect((await rows("SELECT revoked_at FROM doctor_patient"))[0]?.revoked_at).not.toBeNull();
    await reserve(s, `${TUESDAY}T11:00`, { authorize: true });
    expect((await rows("SELECT revoked_at, origin FROM doctor_patient"))[0]).toMatchObject({ revoked_at: null, origin: "patient" });
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(2);
  });

  it("un vínculo creado por el consultorio sin autorización también pide la casilla", async () => {
    const s = await scenario();
    await pool.execute("INSERT INTO doctor_patient (doctor_id, patient_id, origin) VALUES (?, ?, 'office')", [s.doctor.doctorId, s.patient.patientId]);
    await expect(reserve(s, `${TUESDAY}T10:00`, { authorize: false })).rejects.toBeInstanceOf(ValidationError);
    await reserve(s, `${TUESDAY}T10:00`, { authorize: true });
    expect((await rows("SELECT origin FROM doctor_patient"))[0]?.origin).toBe("office"); // el vínculo vigente conserva su origen
  });
});

describe("reserveAsPatient: horario y anticipaciones", () => {
  it("acepta el borde inclusivo de la anticipación mínima y rechaza un minuto antes", async () => {
    const s = await scenario(); // mínima 120 min: lunes 10:00 es el primer horario permitido
    await expect(reserve(s, "2026-06-15T09:00")).rejects.toMatchObject({ code: "slot_unavailable" });
    expect((await reserve(s, "2026-06-15T10:00")).created).toBe(true);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
  });

  it("acepta el borde inclusivo de la anticipación máxima y rechaza el siguiente horario", async () => {
    clock.set(new Date("2026-06-15T15:00:00.000Z")); // lunes 9:00 locales
    const s = await scenario({ settings: { maxAdvanceDays: 1, minNoticeMinutes: 0 } });
    await expect(reserve(s, `${TUESDAY}T10:00`)).rejects.toMatchObject({ code: "slot_unavailable" });
    expect((await reserve(s, `${TUESDAY}T09:00`)).created).toBe(true); // exactamente 24 h después
  });

  it("rechaza un horario que no existe en la configuración (400)", async () => {
    const s = await scenario();
    for (const startLocal of [`${TUESDAY}T10:30`, "2026-06-20T10:00", `${TUESDAY}T20:00`, "no-es-fecha"]) {
      await expect(reserve(s, startLocal)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("rechaza un horario pasado", async () => {
    const s = await scenario();
    await expect(reserve(s, "2026-06-10T10:00")).rejects.toBeInstanceOf(ConflictError);
  });

  it("rechaza un horario ocupado y uno bloqueado con slot_unavailable", async () => {
    const s = await scenario();
    const other = await createPatient(pool);
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
    await createBlock(pool, { doctorId: s.doctor.doctorId, startUtc: localAt(MX, TUESDAY, "11:00"), endUtc: localAt(MX, TUESDAY, "12:00") });
    await expect(reserve(s, `${TUESDAY}T10:00`)).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(reserve(s, `${TUESDAY}T11:00`)).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
  });

  it("una cita cancelada libera el horario", async () => {
    const s = await scenario();
    const other = await createPatient(pool);
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, TUESDAY, "10:00"), status: "cancelled" });
    expect((await reserve(s, `${TUESDAY}T10:00`)).created).toBe(true);
  });
});

describe("reserveAsPatient: consultorio y paciente", () => {
  it("con el micrositio despublicado, sin micrositio o con el médico no aprobado responde 403", async () => {
    const s = await scenario();
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [s.doctor.doctorId]);
    await expect(reserve(s, `${TUESDAY}T10:00`)).rejects.toBeInstanceOf(SiteUnavailableError);
    await pool.execute("UPDATE doctor_site SET status = 'published' WHERE doctor_id = ?", [s.doctor.doctorId]);
    await pool.execute("UPDATE doctor SET approval_status = 'rejected' WHERE id = ?", [s.doctor.doctorId]);
    await expect(reserve(s, `${TUESDAY}T10:00`)).rejects.toBeInstanceOf(SiteUnavailableError);
    await pool.execute("DELETE FROM doctor_site WHERE doctor_id = ?", [s.doctor.doctorId]);
    await expect(reserve(s, `${TUESDAY}T10:00`)).rejects.toBeInstanceOf(SiteUnavailableError);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("un paciente de otra cuenta o inexistente da 404 sin crear nada", async () => {
    const s = await scenario();
    const stranger = await createPatient(pool);
    await expect(reserve(s, `${TUESDAY}T10:00`, { patientId: stranger.patientId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reserve(s, `${TUESDAY}T10:00`, { patientId: 999999 })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
  });

  it("un actor que no es paciente de cuenta alguna no puede reservar", async () => {
    const s = await scenario();
    const doctorAsActor = createPatientContext(s.doctor.doctorId, s.doctor.user.id);
    await expect(reserveAsPatient(doctorAsActor, deps, { startLocal: `${TUESDAY}T10:00`, patientId: s.patient.patientId, authorize: true })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reserveAsPatient: límites por cuenta", () => {
  it("permite 5 reservas por hora por cuenta (entre consultorios) y rechaza la sexta con 429; una hora después vuelve a permitir", async () => {
    const s = await scenario();
    const second = await createDependent(pool, s.patient.accountId, "Hijo Uno");
    const third = await createDependent(pool, s.patient.accountId, "Hijo Dos");
    const plan: [string, number][] = [
      ["2026-06-17T10:00", s.patient.patientId],
      ["2026-06-17T11:00", s.patient.patientId],
      ["2026-06-17T12:00", s.patient.patientId],
      ["2026-06-18T10:00", second],
      ["2026-06-18T11:00", second],
    ];
    for (const [startLocal, patientId] of plan) await reserve(s, startLocal, { patientId });
    const error = await reserve(s, "2026-06-17T13:00", { patientId: third }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyAttemptsError);
    expect((error as TooManyAttemptsError).retryAfterMs).toBeGreaterThan(0);
    expect(await rows("SELECT id FROM appointment")).toHaveLength(5);

    clock.set(new Date("2026-06-15T15:01:00.000Z"));
    expect((await reserve(s, "2026-06-17T13:00", { patientId: third })).created).toBe(true);
  });

  it("el límite cuenta por cuenta, no por consultorio ni por IP: otra cuenta no se ve afectada", async () => {
    const s = await scenario();
    const second = await createDependent(pool, s.patient.accountId);
    for (const time of ["10:00", "11:00", "12:00"]) await reserve(s, `2026-06-17T${time}`);
    await reserve(s, "2026-06-18T10:00", { patientId: second });
    await reserve(s, "2026-06-18T11:00", { patientId: second });
    await expect(reserve(s, "2026-06-18T12:00", { patientId: second })).rejects.toBeInstanceOf(TooManyAttemptsError);
    const otherPatient = await createPatient(pool);
    const otherCtx = createPatientContext(s.doctor.doctorId, otherPatient.user.id);
    expect((await reserveAsPatient(otherCtx, deps, { startLocal: "2026-06-18T12:00", patientId: otherPatient.patientId, authorize: true })).created).toBe(true);
  });

  it("permite 3 citas vigentes por paciente con el consultorio; las canceladas y las pasadas no cuentan", async () => {
    const s = await scenario();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, "2026-06-22", "10:00"), status: "cancelled" });
    await reserve(s, "2026-06-17T10:00");
    await reserve(s, "2026-06-17T11:00");
    await reserve(s, "2026-06-17T12:00");
    await expect(reserve(s, "2026-06-17T13:00")).rejects.toMatchObject({ code: "appointment_limit" });
    // Una cita que ya pasó deja de contar.
    clock.set(new Date("2026-06-17T17:30:00.000Z")); // 11:30 locales: la de 10:00 ya terminó
    expect((await reserve(s, "2026-06-18T10:00")).created).toBe(true);
  });
});

describe("reserveAsPatient: doble envío", () => {
  it("una segunda petición idéntica devuelve la cita ya creada: sin otra cita, otra autorización ni otro correo", async () => {
    const s = await scenario();
    const first = await reserve(s, `${TUESDAY}T10:00`);
    const emails = (await rows("SELECT id FROM email_outbox")).length;
    const second = await reserve(s, `${TUESDAY}T10:00`, { authorize: false });
    expect(second).toMatchObject({ id: first.id, created: false });
    expect(await rows("SELECT id FROM appointment")).toHaveLength(1);
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
    expect(await rows("SELECT id FROM calendar_action_log WHERE action = 'appointment_created'")).toHaveLength(1);
    expect(await rows("SELECT id FROM email_outbox")).toHaveLength(emails);
  });

  it("el mismo horario pedido por OTRA cuenta no es un doble envío: es un conflicto", async () => {
    const s = await scenario();
    await reserve(s, `${TUESDAY}T10:00`);
    const other = await createPatient(pool);
    const otherCtx = createPatientContext(s.doctor.doctorId, other.user.id);
    await expect(reserveAsPatient(otherCtx, deps, { startLocal: `${TUESDAY}T10:00`, patientId: other.patientId, authorize: true })).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("un doble envío que ya no cuenta como vigente (cita cancelada) vuelve a reservar", async () => {
    const s = await scenario();
    const first = await reserve(s, `${TUESDAY}T10:00`);
    await pool.execute("UPDATE appointment SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_by_role = 'patient', cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?", [s.patient.user.id, first.id]);
    const again = await reserve(s, `${TUESDAY}T10:00`);
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(first.id);
  });
});
