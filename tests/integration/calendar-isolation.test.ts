import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/http/errors.js";
import { createTenantContext, type StaffContext } from "../../src/lib/tenant.js";
import { getDay, getWeek } from "../../src/modules/calendar/agenda-service.js";
import { cancelAppointment, createAppointment, describeFreeSlot } from "../../src/modules/calendar/appointment-service.js";
import { findAppointment, listBookedInRange } from "../../src/modules/calendar/appointment-repository.js";
import { listBlocksInRange, listUpcomingBlocks } from "../../src/modules/calendar/block-repository.js";
import { createBlock, removeBlock } from "../../src/modules/calendar/block-service.js";
import { listLinkedPatients } from "../../src/modules/calendar/patient-picker.js";
import {
  clearTables,
  createAppointment as insertAppointment,
  createBlock as insertBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createMembership,
  createPatient,
  createTestPool,
  createUser,
  resetDatabase,
  WEEKDAY_HOURS,
} from "./helpers/db.js";
import { createTestApp, localAt, sessionFor, uniqueIp, type TestApp } from "./helpers/app.js";

// Aislamiento por médico (principio II): la agenda de un médico es invisible e intocable para otro.
const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z");
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const deps = () => ({ db: pool, clock: t.clock, ticketSecret: "s".repeat(40) });

interface Practice {
  doctorId: number;
  userId: number;
  ctx: StaffContext;
  patientId: number;
  patientName: string;
  appointmentId: number;
  blockId: number;
}

/** Un consultorio completo: configuración, una cita a las 10:00 y un bloqueo de 12:00 a 13:00 el martes. */
async function practice(label: string): Promise<Practice> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId);
  await createCalendarHours(pool, doctor.doctorId, WEEKDAY_HOURS);
  const patient = await createPatient(pool, { fullName: `Paciente de ${label}` });
  const appointmentId = await insertAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, TUESDAY, "10:00") });
  const blockId = await insertBlock(pool, { doctorId: doctor.doctorId, startUtc: localAt(MX, TUESDAY, "12:00"), endUtc: localAt(MX, TUESDAY, "13:00") });
  return {
    doctorId: doctor.doctorId,
    userId: doctor.user.id,
    ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }),
    patientId: patient.patientId,
    patientName: `Paciente de ${label}`,
    appointmentId,
    blockId,
  };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

async function snapshotOf(doctorId: number): Promise<unknown> {
  return {
    appointments: await rows("SELECT id, patient_id, start_utc, end_utc, status, cancelled_at FROM appointment WHERE doctor_id = ? ORDER BY id", [doctorId]),
    blocks: await rows("SELECT id, start_utc, end_utc FROM calendar_block WHERE doctor_id = ? ORDER BY id", [doctorId]),
    settings: await rows("SELECT * FROM calendar_settings WHERE doctor_id = ?", [doctorId]),
    hours: await rows("SELECT * FROM calendar_hours WHERE doctor_id = ? ORDER BY id", [doctorId]),
  };
}

describe("lecturas", () => {
  it("la agenda de un médico no contiene citas, bloqueos ni nombres de otro", async () => {
    const a = await practice("A");
    const b = await practice("B");
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      const day = await getDay(mine.ctx, pool, TUESDAY, t.clock.now());
      const week = await getWeek(mine.ctx, pool, TUESDAY, t.clock.now());
      for (const view of [JSON.stringify(day), JSON.stringify(week)]) {
        expect(view).toContain(mine.patientName);
        expect(view).not.toContain(theirs.patientName);
      }
      expect(day.appointments.map((x) => x.id)).toEqual([mine.appointmentId]);
      expect(day.blocks.map((x) => x.id)).toEqual([mine.blockId]);
    }
  });

  it("los repositorios devuelven null o nada para los ids de otro médico", async () => {
    const a = await practice("A");
    const b = await practice("B");
    expect(await findAppointment(b.ctx, pool, a.appointmentId)).toBeNull();
    expect((await listBookedInRange(b.ctx, pool, localAt(MX, TUESDAY, "00:00"), localAt(MX, "2026-06-17", "00:00"))).map((x) => x.id)).toEqual([b.appointmentId]);
    expect((await listBlocksInRange(b.ctx, pool, localAt(MX, TUESDAY, "00:00"), localAt(MX, "2026-06-17", "00:00"))).map((x) => x.id)).toEqual([b.blockId]);
    expect((await listUpcomingBlocks(b.ctx, pool, t.clock.now())).map((x) => x.id)).toEqual([b.blockId]);
  });

  it("el selector de pacientes solo lista a los vinculados con el médico", async () => {
    const a = await practice("A");
    const b = await practice("B");
    expect(await listLinkedPatients(a.ctx, pool)).toEqual([{ patientId: a.patientId, fullName: a.patientName }]);
    expect(await listLinkedPatients(b.ctx, pool)).toEqual([{ patientId: b.patientId, fullName: b.patientName }]);
  });

  it("describeFreeSlot de B no se ve afectado por la cita de A en el mismo horario", async () => {
    const a = await practice("A");
    const b = await practice("B");
    await pool.execute("DELETE FROM appointment WHERE id = ?", [b.appointmentId]);
    expect(await describeFreeSlot(b.ctx, pool, `${TUESDAY}T10:00`, t.clock.now())).not.toBeNull(); // libre para B
    expect(await describeFreeSlot(a.ctx, pool, `${TUESDAY}T10:00`, t.clock.now())).toBeNull(); // ocupado para A
  });
});

describe("escrituras", () => {
  it("cancelar, desbloquear o consultar con ids de otro médico es NotFound y no cambia nada", async () => {
    const a = await practice("A");
    const b = await practice("B");
    const before = await snapshotOf(a.doctorId);
    await expect(cancelAppointment(b.ctx, deps(), a.appointmentId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeBlock(b.ctx, deps(), a.blockId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await snapshotOf(a.doctorId)).toEqual(before);
    expect(await rows("SELECT id FROM email_outbox")).toEqual([]);
  });

  it("agendar a un paciente de otro médico sin boleto es NotFound y no vincula ni crea nada", async () => {
    const a = await practice("A");
    const b = await practice("B");
    await expect(createAppointment(b.ctx, deps(), { startLocal: `${TUESDAY}T11:00`, patientId: a.patientId })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows("SELECT doctor_id FROM doctor_patient WHERE patient_id = ?", [a.patientId])).toEqual([{ doctor_id: a.doctorId }]);
    expect(await rows("SELECT id FROM appointment WHERE doctor_id = ?", [b.doctorId])).toHaveLength(1); // solo la suya de fábrica
  });

  it("bloquear un horario donde otro médico tiene citas no choca con ellas", async () => {
    const a = await practice("A");
    const b = await practice("B");
    await pool.execute("DELETE FROM appointment WHERE id = ?", [b.appointmentId]);
    await expect(createBlock(b.ctx, deps(), { fromLocal: `${TUESDAY}T09:00`, toLocal: `${TUESDAY}T11:00` })).resolves.toBeDefined();
    expect(await rows("SELECT status FROM appointment WHERE id = ?", [a.appointmentId])).toEqual([{ status: "booked" }]);
  });

  it("toda acción queda registrada con el médico de quien actuó, nunca con otro", async () => {
    const a = await practice("A");
    const b = await practice("B");
    await createAppointment(a.ctx, deps(), { startLocal: `${TUESDAY}T11:00`, patientId: a.patientId });
    await createBlock(b.ctx, deps(), { fromLocal: `${TUESDAY}T16:00`, toLocal: `${TUESDAY}T17:00` });
    expect(await rows("SELECT doctor_id, action FROM calendar_action_log ORDER BY id")).toEqual([
      { doctor_id: a.doctorId, action: "appointment_created" },
      { doctor_id: b.doctorId, action: "block_created" },
    ]);
  });
});

describe("recepción", () => {
  it("la recepción de un médico no puede operar sobre el de otro, aunque su sesión apunte a él", async () => {
    const a = await practice("A");
    const b = await practice("B");
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, a.doctorId, person.id); // solo trabaja con A
    const client = await sessionFor(t.services, person);
    const session = await t.services.sessions.validate(client.cookie.split("=")[1] ?? "");
    await t.services.sessions.setActiveDoctor(session?.sessionId ?? 0, b.doctorId); // apunta a B sin vínculo
    const before = await snapshotOf(b.doctorId);

    for (const [method, url] of [
      ["GET", `/agenda/dia/${TUESDAY}`],
      ["GET", `/agenda/semana/${TUESDAY}`],
      ["GET", `/agenda/citas/${b.appointmentId}`],
      ["GET", "/agenda/bloqueos"],
    ] as const) {
      const response = await t.app.inject({ method, url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept: "application/json" } });
      expect(response.statusCode, url).toBe(403);
    }
    for (const url of [`/agenda/citas/${b.appointmentId}/cancelar`, `/agenda/bloqueos/${b.blockId}/eliminar`, "/agenda/bloqueos/espacio"]) {
      const response = await t.app.inject({
        method: "POST",
        url,
        remoteAddress: uniqueIp(),
        headers: { cookie: client.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ _csrf: client.csrf, inicio: `${TUESDAY}T10:00` }).toString(),
      });
      expect(response.statusCode, url).toBe(403);
    }
    expect(await snapshotOf(b.doctorId)).toEqual(before);
  });
});
