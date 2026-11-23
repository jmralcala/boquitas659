import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantContext } from "../../src/lib/tenant.js";
import { DEFAULT_SETTINGS } from "../../src/modules/calendar/settings.js";
import { loadSettings } from "../../src/modules/calendar/settings-repository.js";
import { clearTables, createDoctor, createTestPool, resetDatabase } from "./helpers/db.js";

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

async function ctxFor(doctorId: number, userId: number): Promise<ReturnType<typeof createTenantContext>> {
  return createTenantContext(doctorId, { kind: "doctor", userId });
}

describe("loadSettings", () => {
  it("sin fila devuelve los valores por defecto, sin franjas y marcados como por defecto", async () => {
    const doctor = await createDoctor(pool);
    const config = await loadSettings(await ctxFor(doctor.doctorId, doctor.user.id), pool);
    expect(config).toEqual({ settings: DEFAULT_SETTINGS, hours: [], isDefault: true });
    expect(DEFAULT_SETTINGS).toEqual({ slotMinutes: 45, gapMinutes: 15, timezone: "America/Mexico_City", minNoticeMinutes: 120, maxAdvanceDays: 60 });
  });

  it("con fila y franjas las lee tal cual, ordenadas por día e inicio", async () => {
    const doctor = await createDoctor(pool);
    await pool.execute(
      `INSERT INTO calendar_settings (doctor_id, slot_minutes, gap_minutes, timezone, min_notice_minutes, max_advance_days, updated_at)
       VALUES (?, 30, 0, 'America/Tijuana', 60, 90, UTC_TIMESTAMP(3))`,
      [doctor.doctorId],
    );
    await pool.execute(
      "INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, 2, 960, 1080), (?, 1, 960, 1080), (?, 1, 540, 840)",
      [doctor.doctorId, doctor.doctorId, doctor.doctorId],
    );
    const config = await loadSettings(await ctxFor(doctor.doctorId, doctor.user.id), pool);
    expect(config.isDefault).toBe(false);
    expect(config.settings).toEqual({ slotMinutes: 30, gapMinutes: 0, timezone: "America/Tijuana", minNoticeMinutes: 60, maxAdvanceDays: 90 });
    expect(config.hours).toEqual([
      { weekday: 1, startMinute: 540, endMinute: 840 },
      { weekday: 1, startMinute: 960, endMinute: 1080 },
      { weekday: 2, startMinute: 960, endMinute: 1080 },
    ]);
  });

  it("aislamiento: un médico no ve la configuración ni las franjas de otro", async () => {
    const a = await createDoctor(pool);
    const b = await createDoctor(pool);
    await pool.execute("INSERT INTO calendar_settings (doctor_id, slot_minutes, updated_at) VALUES (?, 60, UTC_TIMESTAMP(3))", [a.doctorId]);
    await pool.execute("INSERT INTO calendar_hours (doctor_id, weekday, start_minute, end_minute) VALUES (?, 1, 540, 840)", [a.doctorId]);

    const forB = await loadSettings(await ctxFor(b.doctorId, b.user.id), pool);
    expect(forB).toEqual({ settings: DEFAULT_SETTINGS, hours: [], isDefault: true });
    const forA = await loadSettings(await ctxFor(a.doctorId, a.user.id), pool);
    expect(forA.settings.slotMinutes).toBe(60);
    expect(forA.hours).toHaveLength(1);
  });
});
