import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createTenantContext } from "../../src/lib/tenant.js";
import { loadSettings, saveSettings } from "../../src/modules/calendar/settings-repository.js";
import type { CalendarSettings, HoursRange } from "../../src/lib/calendar-slots.js";
import {
  clearTables,
  createAppointment,
  createBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createMembership,
  createPatient,
  createTestPool,
  createUser,
  resetDatabase,
} from "./helpers/db.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T18:00:00.000Z"));

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

const SETTINGS: CalendarSettings = { slotMinutes: 30, gapMinutes: 0, timezone: "America/Tijuana", minNoticeMinutes: 60, maxAdvanceDays: 90, cancelNoticeHours: 12 };
const HOURS: HoursRange[] = [
  { weekday: 1, startMinute: 540, endMinute: 840 },
  { weekday: 2, startMinute: 600, endMinute: 720 },
];

async function doctorCtx(): Promise<{ ctx: ReturnType<typeof createTenantContext>; doctorId: number; userId: number }> {
  const doctor = await createDoctor(pool);
  return { ctx: createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id }), doctorId: doctor.doctorId, userId: doctor.user.id };
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

describe("saveSettings", () => {
  it("guarda la configuración y las franjas y se leen de vuelta", async () => {
    const { ctx } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: SETTINGS, hours: HOURS }, clock);
    expect(await loadSettings(ctx, pool)).toEqual({ settings: SETTINGS, hours: HOURS, isDefault: false });
  });

  it("guardar de nuevo reemplaza las franjas completas (borra las que ya no están)", async () => {
    const { ctx } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: SETTINGS, hours: HOURS }, clock);
    const second: HoursRange[] = [{ weekday: 5, startMinute: 480, endMinute: 600 }];
    await saveSettings(ctx, pool, { settings: { ...SETTINGS, slotMinutes: 60 }, hours: second }, clock);
    const config = await loadSettings(ctx, pool);
    expect(config.hours).toEqual(second);
    expect(config.settings.slotMinutes).toBe(60);
    expect(await rows("SELECT COUNT(*) AS n FROM calendar_settings")).toMatchObject([{ n: 1 }]);
  });

  it("guardar sin ninguna franja deja el horario vacío", async () => {
    const { ctx } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: SETTINGS, hours: HOURS }, clock);
    await saveSettings(ctx, pool, { settings: SETTINGS, hours: [] }, clock);
    expect((await loadSettings(ctx, pool)).hours).toEqual([]);
  });

  it("un guardado que falla a mitad no cambia nada (transacción)", async () => {
    const { ctx } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: SETTINGS, hours: HOURS }, clock);
    const broken: HoursRange[] = [
      { weekday: 3, startMinute: 540, endMinute: 600 },
      { weekday: 3, startMinute: 700, endMinute: 650 }, // viola el CHECK de la base: fin antes que inicio
    ];
    await expect(saveSettings(ctx, pool, { settings: { ...SETTINGS, slotMinutes: 90 }, hours: broken }, clock)).rejects.toThrow();
    const config = await loadSettings(ctx, pool);
    expect(config.settings.slotMinutes).toBe(30);
    expect(config.hours).toEqual(HOURS);
  });

  it("registra settings_updated con quién y cuándo", async () => {
    const { ctx, doctorId, userId } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: SETTINGS, hours: HOURS }, clock);
    const log = await rows("SELECT * FROM calendar_action_log");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ doctor_id: doctorId, actor_user_id: userId, actor_role: "doctor", action: "settings_updated", outcome: "ok" });
    expect((log[0]?.occurred_at as Date).toISOString()).toBe(clock.now().toISOString());
  });

  it("la recepción no puede guardar la configuración (403) y no queda nada guardado ni registrado", async () => {
    const doctor = await createDoctor(pool);
    const person = await createUser(pool, { role: "reception" });
    await createMembership(pool, doctor.doctorId, person.id);
    const ctx = createTenantContext(doctor.doctorId, { kind: "reception", userId: person.id });
    await expect(saveSettings(ctx, pool, { settings: SETTINGS, hours: HOURS }, clock)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await rows("SELECT * FROM calendar_settings")).toEqual([]);
    expect(await rows("SELECT * FROM calendar_action_log")).toEqual([]);
  });

  it("aislamiento: guardar la configuración de un médico no toca la de otro", async () => {
    const a = await doctorCtx();
    const b = await doctorCtx();
    await createCalendarSettings(pool, b.doctorId, { slotMinutes: 60 });
    await createCalendarHours(pool, b.doctorId, [{ weekday: 4, startMinute: 600, endMinute: 660 }]);
    await saveSettings(a.ctx, pool, { settings: SETTINGS, hours: HOURS }, clock);
    const forB = await loadSettings(b.ctx, pool);
    expect(forB.settings.slotMinutes).toBe(60);
    expect(forB.hours).toEqual([{ weekday: 4, startMinute: 600, endMinute: 660 }]);
  });

  describe("no modifica ni cancela citas ni bloqueos existentes", () => {
    it("cambiar duración, horario, zona y anticipación deja intactas las citas y los bloqueos", async () => {
      const { ctx, doctorId } = await doctorCtx();
      const patient = await createPatient(pool);
      await createCalendarSettings(pool, doctorId);
      await createCalendarHours(pool, doctorId, [{ weekday: 1, startMinute: 540, endMinute: 840 }]);
      const start = new Date("2026-07-06T15:00:00.000Z");
      const bookedId = await createAppointment(pool, { doctorId, patientId: patient.patientId, startUtc: start });
      const cancelledId = await createAppointment(pool, { doctorId, patientId: patient.patientId, startUtc: new Date("2026-07-07T15:00:00.000Z"), status: "cancelled" });
      const blockId = await createBlock(pool, { doctorId, startUtc: new Date("2026-07-08T15:00:00.000Z"), endUtc: new Date("2026-07-08T20:00:00.000Z") });

      const snapshot = async (): Promise<unknown> => ({
        appointments: await rows("SELECT id, patient_id, start_utc, end_utc, status, cancelled_at FROM appointment ORDER BY id"),
        blocks: await rows("SELECT id, start_utc, end_utc FROM calendar_block ORDER BY id"),
      });
      const before = await snapshot();

      await saveSettings(
        ctx,
        pool,
        {
          settings: { slotMinutes: 20, gapMinutes: 5, timezone: "America/Cancun", minNoticeMinutes: 0, maxAdvanceDays: 5, cancelNoticeHours: 72 },
          hours: [{ weekday: 6, startMinute: 0, endMinute: 60 }],
        },
        clock,
      );

      expect(await snapshot()).toEqual(before);
      expect(bookedId).toBeGreaterThan(0);
      expect(cancelledId).toBeGreaterThan(0);
      expect(blockId).toBeGreaterThan(0);
    });

    it("cambiar la zona horaria no altera start_utc ni end_utc de las citas (solo cambia cómo se muestran)", async () => {
      const { ctx, doctorId } = await doctorCtx();
      const patient = await createPatient(pool);
      await createCalendarSettings(pool, doctorId, { timezone: "America/Mexico_City" });
      const start = new Date("2026-07-06T15:00:00.000Z");
      const id = await createAppointment(pool, { doctorId, patientId: patient.patientId, startUtc: start });
      await saveSettings(ctx, pool, { settings: { ...SETTINGS, timezone: "America/Tijuana" }, hours: HOURS }, clock);
      const [row] = await rows("SELECT start_utc, end_utc, status FROM appointment WHERE id = ?", [id]);
      expect((row?.start_utc as Date).toISOString()).toBe("2026-07-06T15:00:00.000Z");
      expect((row?.end_utc as Date).toISOString()).toBe("2026-07-06T15:45:00.000Z");
      expect(row?.status).toBe("booked");
    });
  });

  it("el límite de cancelación se guarda, se lee de vuelta y por defecto vale 24", async () => {
    const { ctx } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: { ...SETTINGS, cancelNoticeHours: 72 }, hours: HOURS }, clock);
    expect((await loadSettings(ctx, pool)).settings.cancelNoticeHours).toBe(72);
    const other = await doctorCtx();
    expect((await loadSettings(other.ctx, pool)).settings.cancelNoticeHours).toBe(24);
  });

  it("la anticipación guardada queda disponible para la comprobación de reserva", async () => {
    const { ctx } = await doctorCtx();
    await saveSettings(ctx, pool, { settings: { ...SETTINGS, minNoticeMinutes: 180, maxAdvanceDays: 30 }, hours: HOURS }, clock);
    const { settings } = await loadSettings(ctx, pool);
    expect(settings.minNoticeMinutes).toBe(180);
    expect(settings.maxAdvanceDays).toBe(30);
  });
});
