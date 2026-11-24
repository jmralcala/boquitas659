import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, SiteUnavailableError, ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext, type TenantContext } from "../../src/lib/tenant.js";
import { CATEGORY_IDS, type CategoryId } from "../../src/modules/urgent/triage-content.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
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
  WEEKDAY_HOURS,
  type CreatedDoctor,
  type CreatedPatient,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
const deps = { db: pool, clock };
const MX = "America/Mexico_City";
const MONDAY = "2026-06-15";
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

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

/** Horario regular de los ejemplos (9–14 y 16–19) y una franja de urgencia de lunes a viernes de 14:00 a 16:00. */
const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));

interface Scenario {
  doctor: CreatedDoctor;
  patient: CreatedPatient;
  ctx: TenantContext;
}

async function scenario(options: { hours?: NonNullable<Parameters<typeof createPublishedSite>[2]>["hours"]; urgentMinNoticeMinutes?: number } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
  await createPublishedSite(pool, doctor, {
    hours: options.hours ?? [...WEEKDAY_HOURS, ...URGENT_HOURS],
    settings: options.urgentMinNoticeMinutes === undefined ? {} : { urgentMinNoticeMinutes: options.urgentMinNoticeMinutes },
  });
  const patient = await createPatient(pool);
  return { doctor, patient, ctx: createPatientContext(doctor.doctorId, patient.user.id) };
}

const request = (s: Scenario, category: CategoryId = "rojo", extra: { patientId?: number; authorize?: boolean } = {}) =>
  requestUrgent(s.ctx, deps, { patientId: extra.patientId ?? s.patient.patientId, category, authorize: extra.authorize ?? true });

/** Ocupa con otra persona todos los espacios (regulares y de urgencia) desde el lunes 9:00 hasta el martes 8:59. */
async function occupyMonday(s: Scenario): Promise<void> {
  const other = await createPatient(pool);
  for (const hour of ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]) {
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, MONDAY, hour) });
  }
}

describe("requestUrgent: asignación", () => {
  it("asigna el espacio libre más próximo, crea la cita urgente a nombre del paciente y deja la acción registrada", async () => {
    const s = await scenario();
    const result = await request(s);
    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") return;
    // Lunes 8:00 + 30 min → 8:30; el primer espacio es el de las 9:00.
    expect(result.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "09:00").toISOString());
    expect(result.endUtc.getTime() - result.startUtc.getTime()).toBe(45 * 60_000);
    const [appointment] = await rows("SELECT * FROM appointment WHERE id = ?", [result.id]);
    expect(appointment).toMatchObject({
      doctor_id: s.doctor.doctorId,
      patient_id: s.patient.patientId,
      status: "booked",
      kind: "urgent",
      created_by_user_id: s.patient.user.id,
      created_by_role: "patient",
    });
    const log = await rows("SELECT action, outcome, actor_role, appointment_id FROM calendar_action_log ORDER BY id");
    expect(log).toEqual([
      { action: "data_authorized", outcome: "ok", actor_role: "patient", appointment_id: null },
      { action: "urgent_requested", outcome: "ok", actor_role: "patient", appointment_id: result.id },
    ]);
  });

  it("crea el vínculo (origen paciente) y registra la autorización de datos; sin la casilla no crea nada", async () => {
    const s = await scenario();
    const error = await request(s, "rojo", { authorize: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(Object.keys((error as ValidationError).fields ?? {})).toEqual(["autorizo"]);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
    expect(await rows("SELECT id FROM data_authorization")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);

    await request(s);
    expect(await rows("SELECT origin, revoked_at FROM doctor_patient")).toEqual([{ origin: "patient", revoked_at: null }]);
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
  });

  it("con una autorización activa no pide la casilla ni registra otra", async () => {
    const s = await scenario();
    await createDataAuthorization(pool, { accountId: s.patient.accountId, doctorId: s.doctor.doctorId, userId: s.patient.user.id, at: new Date("2026-06-01T00:00:00Z") });
    const result = await request(s, "rojo", { authorize: false });
    expect(result.kind).toBe("scheduled");
    expect(await rows("SELECT id FROM data_authorization")).toHaveLength(1);
  });

  it("la cita de un menor queda a su nombre con la autorización del tutor", async () => {
    const s = await scenario();
    const minorId = await createDependent(pool, s.patient.accountId, "Hijo de Prueba");
    const result = await request(s, "rojo", { patientId: minorId });
    expect(result.kind).toBe("scheduled");
    expect(await rows("SELECT patient_id, created_by_user_id, kind FROM appointment")).toEqual([{ patient_id: minorId, created_by_user_id: s.patient.user.id, kind: "urgent" }]);
    expect((await rows("SELECT given_by_user_id FROM data_authorization"))[0]?.given_by_user_id).toBe(s.patient.user.id);
  });

  it("la ventana de cada categoría decide hasta dónde se busca (Rojo 2 h, Naranja 12 h, Amarillo 24 h, Verde claro 48 h, Verde 72 h)", async () => {
    // Todo ocupado el lunes: el primer espacio libre es el martes 9:00, 25 horas después de ahora.
    const expected: Record<CategoryId, "scheduled" | "no_space"> = { rojo: "no_space", naranja: "no_space", amarillo: "no_space", verde_claro: "scheduled", verde: "scheduled" };
    for (const category of CATEGORY_IDS) {
      await clearTables(pool);
      await ensurePrivacyDocument(pool);
      const s = await scenario();
      await occupyMonday(s);
      const result = await request(s, category);
      expect(result.kind, category).toBe(expected[category]);
      if (result.kind === "scheduled") expect(result.startUtc.toISOString(), category).toBe(localAt(MX, TUESDAY, "09:00").toISOString());
    }
  });

  it("un espacio de urgencia dentro de la ventana también se asigna (el lunes 14:00 con Naranja)", async () => {
    const s = await scenario();
    const other = await createPatient(pool);
    for (const hour of ["09:00", "10:00", "11:00", "12:00", "13:00"]) {
      await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, MONDAY, hour) });
    }
    expect((await request(s, "rojo")).kind).toBe("no_space"); // 14:00 queda a 6 h: fuera de la ventana de 2 h
    const result = await request(s, "naranja");
    expect(result.kind).toBe("scheduled");
    if (result.kind === "scheduled") expect(result.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "14:00").toISOString());
  });

  it("respeta la anticipación mínima de urgencias configurada por el médico (borde inclusivo)", async () => {
    const strict = await scenario({ urgentMinNoticeMinutes: 90 });
    const first = await request(strict);
    // 8:00 + 90 min = 9:30 → el espacio de las 10:00 (a 2 h: justo en el borde de la ventana de Rojo).
    expect(first.kind === "scheduled" && first.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "10:00").toISOString());

    const exact = await scenario({ urgentMinNoticeMinutes: 60 });
    const second = await request(exact);
    expect(second.kind === "scheduled" && second.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "09:00").toISOString()); // justo en el límite
  });

  it("nunca asigna espacios ocupados, bloqueados ni cancelados como si estuvieran ocupados", async () => {
    const s = await scenario();
    const other = await createPatient(pool);
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, MONDAY, "09:00") });
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, MONDAY, "10:00"), status: "cancelled" });
    const result = await request(s);
    // 9:00 ocupado: el siguiente es el de las 10:00 (su cita está cancelada, así que el espacio está libre).
    expect(result.kind === "scheduled" && result.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "10:00").toISOString());

    await clearTables(pool);
    await ensurePrivacyDocument(pool);
    const blocked = await scenario();
    await createBlock(pool, { doctorId: blocked.doctor.doctorId, startUtc: localAt(MX, MONDAY, "09:00"), endUtc: localAt(MX, MONDAY, "10:00") });
    const next = await request(blocked);
    expect(next.kind === "scheduled" && next.startUtc.toISOString()).toBe(localAt(MX, MONDAY, "10:00").toISOString());
  });

  it("no desplaza citas ya agendadas", async () => {
    const s = await scenario();
    const other = await createPatient(pool);
    const existing = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: other.patientId, startUtc: localAt(MX, MONDAY, "09:00") });
    await request(s);
    expect(await rows("SELECT status, start_utc FROM appointment WHERE id = ?", [existing])).toEqual([{ status: "booked", start_utc: localAt(MX, MONDAY, "09:00") }]);
  });

  it("no usa espacios que no existen en el horario (sin franjas no hay cita)", async () => {
    const s = await scenario({ hours: [] });
    const result = await request(s);
    expect(result.kind).toBe("no_space");
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });
});

describe("requestUrgent: consultorio y paciente", () => {
  it("con el micrositio despublicado, sin micrositio o con el médico no aprobado lanza SiteUnavailableError sin crear nada", async () => {
    const s = await scenario();
    await pool.execute("UPDATE doctor_site SET status = 'unpublished' WHERE doctor_id = ?", [s.doctor.doctorId]);
    await expect(request(s)).rejects.toBeInstanceOf(SiteUnavailableError);
    await pool.execute("UPDATE doctor_site SET status = 'published' WHERE doctor_id = ?", [s.doctor.doctorId]);
    await pool.execute("UPDATE doctor SET approval_status = 'rejected' WHERE id = ?", [s.doctor.doctorId]);
    await expect(request(s)).rejects.toBeInstanceOf(SiteUnavailableError);
    await pool.execute("DELETE FROM doctor_site WHERE doctor_id = ?", [s.doctor.doctorId]);
    await expect(request(s)).rejects.toBeInstanceOf(SiteUnavailableError);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });

  it("un paciente de otra cuenta o inexistente lanza NotFoundError sin crear nada", async () => {
    const s = await scenario();
    const stranger = await createPatient(pool);
    await expect(request(s, "rojo", { patientId: stranger.patientId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(request(s, "rojo", { patientId: 999_999 })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM doctor_patient")).toEqual([]);
  });

  it("un actor que no es de una cuenta de paciente no puede pedir urgencias", async () => {
    const s = await scenario();
    const asDoctor = createPatientContext(s.doctor.doctorId, s.doctor.user.id);
    await expect(requestUrgent(asDoctor, deps, { patientId: s.patient.patientId, category: "rojo", authorize: true })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("una categoría que no está en la lista se rechaza sin tocar la base", async () => {
    const s = await scenario();
    await expect(request(s, "inventada" as CategoryId)).rejects.toThrow();
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_action_log")).toEqual([]);
  });
});

describe("requestUrgent: la categoría no se guarda (constitución I)", () => {
  it("ninguna tabla de la cita, el vínculo, la autorización ni el registro guarda la categoría", async () => {
    for (const category of CATEGORY_IDS) {
      await clearTables(pool);
      await ensurePrivacyDocument(pool);
      const s = await scenario();
      await request(s, category);
      const dump = JSON.stringify([
        await rows("SELECT * FROM appointment"),
        await rows("SELECT * FROM doctor_patient"),
        await rows("SELECT * FROM data_authorization"),
        await rows("SELECT * FROM calendar_action_log"),
      ]);
      for (const id of CATEGORY_IDS) expect(dump, `${category} → ${id}`).not.toContain(`"${id}"`);
      expect(dump).not.toMatch(/categor|triage|triaje/i);
    }
  });
});
