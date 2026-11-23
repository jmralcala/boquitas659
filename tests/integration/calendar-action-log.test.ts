import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantContext } from "../../src/lib/tenant.js";
import { countRecentLookups, logCalendarAction } from "../../src/modules/calendar/action-log.js";
import { clearTables, createDoctor, createMembership, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

const NOW = new Date("2026-06-15T18:00:00.000Z");

describe("logCalendarAction", () => {
  it("guarda quién, con qué rol, para qué médico, qué acción, ids, resultado y cuándo", async () => {
    const doctor = await createDoctor(pool);
    const reception = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, reception.id);
    const ctx = createTenantContext(doctor.doctorId, { kind: "reception", userId: reception.id });

    await logCalendarAction(ctx, pool, { action: "block_rejected", outcome: "rejected", blockId: 12, at: NOW });
    await logCalendarAction(ctx, pool, { action: "appointment_created", outcome: "ok", appointmentId: 5, at: NOW });

    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM calendar_action_log ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      doctor_id: doctor.doctorId,
      actor_user_id: reception.id,
      actor_role: "reception",
      action: "block_rejected",
      appointment_id: null,
      block_id: 12,
      outcome: "rejected",
    });
    expect((rows[0]?.occurred_at as Date).toISOString()).toBe(NOW.toISOString());
    expect(rows[1]).toMatchObject({ action: "appointment_created", appointment_id: 5, block_id: null, outcome: "ok" });
  });

  it("no tiene columnas para nombres, correos ni teléfonos", async () => {
    const [columns] = await pool.query<RowDataPacket[]>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'calendar_action_log'",
    );
    const names = columns.map((column) => String(column.name));
    expect(names.filter((name) => /name|email|phone|nombre|correo|tel/i.test(name))).toEqual([]);
  });

  it("no se puede actualizar ni borrar (solo anexar)", async () => {
    const doctor = await createDoctor(pool);
    const ctx = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
    // Con la hora real: lo de más de 90 días sí se puede borrar (retención), lo reciente nunca.
    await logCalendarAction(ctx, pool, { action: "settings_updated", outcome: "ok", at: new Date() });
    await expect(pool.execute("UPDATE calendar_action_log SET outcome = 'rejected'")).rejects.toThrow(/solo anexar/);
    await expect(pool.execute("DELETE FROM calendar_action_log")).rejects.toThrow(/solo anexar/);
  });
});

describe("countRecentLookups: una persona con varios médicos", () => {
  it("byActor suma sus búsquedas con todos los médicos y byDoctor solo las del médico", async () => {
    const a = await createDoctor(pool);
    const b = await createDoctor(pool);
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, a.doctorId, person.id);
    await createMembership(pool, b.doctorId, person.id);
    const withA = createTenantContext(a.doctorId, { kind: "reception", userId: person.id });
    const withB = createTenantContext(b.doctorId, { kind: "reception", userId: person.id });
    const recent = new Date(NOW.getTime() - 10 * 60_000);
    for (let index = 0; index < 3; index += 1) await logCalendarAction(withA, pool, { action: "patient_lookup", outcome: "ok", at: recent });
    for (let index = 0; index < 2; index += 1) await logCalendarAction(withB, pool, { action: "patient_lookup", outcome: "ok", at: recent });
    const since = new Date(NOW.getTime() - 3_600_000);
    expect(await countRecentLookups(withA, pool, since)).toEqual({ byActor: 5, byDoctor: 3 });
    expect(await countRecentLookups(withB, pool, since)).toEqual({ byActor: 5, byDoctor: 2 });
  });
});

describe("countRecentLookups", () => {
  it("cuenta las búsquedas desde un instante, por persona y por médico", async () => {
    const doctor = await createDoctor(pool);
    const other = await createDoctor(pool);
    const reception = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, reception.id);
    const doctorCtx = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
    const receptionCtx = createTenantContext(doctor.doctorId, { kind: "reception", userId: reception.id });
    const otherCtx = createTenantContext(other.doctorId, { kind: "doctor", userId: other.user.id });

    const old = new Date(NOW.getTime() - 2 * 3_600_000);
    const recent = new Date(NOW.getTime() - 10 * 60_000);
    await logCalendarAction(doctorCtx, pool, { action: "patient_lookup", outcome: "ok", at: old });
    await logCalendarAction(doctorCtx, pool, { action: "patient_lookup", outcome: "ok", at: recent });
    await logCalendarAction(doctorCtx, pool, { action: "patient_lookup", outcome: "rejected", at: recent });
    await logCalendarAction(receptionCtx, pool, { action: "patient_lookup", outcome: "ok", at: recent });
    await logCalendarAction(doctorCtx, pool, { action: "appointment_created", outcome: "ok", at: recent }); // otra acción: no cuenta
    await logCalendarAction(otherCtx, pool, { action: "patient_lookup", outcome: "ok", at: recent }); // otro médico

    const since = new Date(NOW.getTime() - 3_600_000);
    expect(await countRecentLookups(doctorCtx, pool, since)).toEqual({ byActor: 2, byDoctor: 3 });
    expect(await countRecentLookups(receptionCtx, pool, since)).toEqual({ byActor: 1, byDoctor: 3 });
    expect(await countRecentLookups(otherCtx, pool, since)).toEqual({ byActor: 1, byDoctor: 1 });
  });
});
