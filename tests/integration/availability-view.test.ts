import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/http/errors.js";
import { createFixedClock } from "../../src/lib/clock.js";
import { createPatientContext, type TenantContext } from "../../src/lib/tenant.js";
import { getDayView, getMonthView } from "../../src/modules/site/availability-view.js";
import {
  clearTables,
  createAppointment,
  createBlock,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createPatient,
  createTestPool,
  resetDatabase,
  WEEKDAY_HOURS,
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const clock = createFixedClock(new Date("2026-06-15T14:00:00.000Z")); // lunes 8:00 en Ciudad de México
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

interface Scenario {
  doctorId: number;
  ctx: TenantContext;
}

async function scenario(options: { settings?: Parameters<typeof createCalendarSettings>[2]; hours?: Parameters<typeof createCalendarHours>[2] } = {}): Promise<Scenario> {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId, options.settings);
  await createCalendarHours(pool, doctor.doctorId, options.hours ?? WEEKDAY_HOURS);
  const patient = await createPatient(pool);
  return { doctorId: doctor.doctorId, ctx: createPatientContext(doctor.doctorId, patient.user.id) };
}

describe("mes", () => {
  it("habilita solo los días con horarios libres que cumplen la anticipación mínima; no hay días pasados", async () => {
    const s = await scenario();
    const month = await getMonthView(s.ctx, pool, "2026-06", clock.now());
    const day = (date: string) => month.days.find((entry) => entry.date === date);
    expect(day("2026-06-14")?.enabled).toBe(false); // pasado
    expect(day("2026-06-13")?.enabled).toBe(false); // pasado (sábado)
    expect(day("2026-06-15")?.enabled).toBe(true); // hoy: quedan horarios después de las 10:00 (8:00 + 2 h)
    expect(day("2026-06-16")?.enabled).toBe(true);
    expect(day("2026-06-20")?.enabled).toBe(false); // sábado sin horario
    expect(day("2026-06-21")?.enabled).toBe(false); // domingo sin horario
    expect(month.days).toHaveLength(30);
    expect(month.prevMonth).toBeNull(); // no se navega a meses pasados
    expect(month.nextMonth).toBe("2026-07");
  });

  it("hoy ofrece solo los horarios posteriores a la anticipación mínima", async () => {
    const s = await scenario();
    const day = await getDayView(s.ctx, pool, "2026-06-15", clock.now());
    expect(day.slots.map((slot) => slot.startLocal.slice(11))).toEqual(["10:00", "11:00", "12:00", "13:00", "16:00", "17:00", "18:00"]);
  });

  it("no hay días posteriores a la anticipación máxima", async () => {
    const s = await scenario(); // 60 días: hasta el 14 de agosto a las 8:00 locales
    const august = await getMonthView(s.ctx, pool, "2026-08", clock.now());
    const day = (date: string) => august.days.find((entry) => entry.date === date);
    expect(day("2026-08-13")?.enabled).toBe(true);
    expect(day("2026-08-14")?.enabled).toBe(false);
    expect(day("2026-08-17")?.enabled).toBe(false);
    expect(august.nextMonth).toBeNull();
    await expect(getMonthView(s.ctx, pool, "2026-09", clock.now())).rejects.toBeInstanceOf(ValidationError);
    await expect(getMonthView(s.ctx, pool, "2026-05", clock.now())).rejects.toBeInstanceOf(ValidationError);
    await expect(getMonthView(s.ctx, pool, "no-es-un-mes", clock.now())).rejects.toBeInstanceOf(ValidationError);
  });

  it("las citas vigentes y los bloqueos quitan horarios; una cita cancelada no", async () => {
    const s = await scenario();
    const patient = await createPatient(pool);
    const before = await getDayView(s.ctx, pool, "2026-06-16", clock.now());
    await createAppointment(pool, { doctorId: s.doctorId, patientId: patient.patientId, startUtc: localAt(MX, "2026-06-16", "10:00") });
    await createAppointment(pool, { doctorId: s.doctorId, patientId: patient.patientId, startUtc: localAt(MX, "2026-06-16", "11:00"), status: "cancelled" });
    await createBlock(pool, { doctorId: s.doctorId, startUtc: localAt(MX, "2026-06-16", "16:00"), endUtc: localAt(MX, "2026-06-16", "19:00") });
    const after = await getDayView(s.ctx, pool, "2026-06-16", clock.now());
    const labels = after.slots.map((slot) => slot.startLocal.slice(11));
    expect(labels).not.toContain("10:00");
    expect(labels).toContain("11:00");
    expect(labels).not.toContain("16:00");
    expect(labels).not.toContain("17:00");
    expect(labels).not.toContain("18:00");
    expect(after.slots.length).toBe(before.slots.length - 4);
  });

  it("un día completamente bloqueado o lleno aparece deshabilitado", async () => {
    const s = await scenario();
    await createBlock(pool, { doctorId: s.doctorId, startUtc: localAt(MX, "2026-06-17", "00:00"), endUtc: localAt(MX, "2026-06-18", "00:00") });
    const month = await getMonthView(s.ctx, pool, "2026-06", clock.now());
    expect(month.days.find((entry) => entry.date === "2026-06-17")?.enabled).toBe(false);
    expect(month.days.find((entry) => entry.date === "2026-06-18")?.enabled).toBe(true);
  });

  it("calcula el mes con UNA consulta de citas y UNA de bloqueos", async () => {
    const s = await scenario();
    const statements: string[] = [];
    const spy = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "execute") {
          return (sql: string, params?: unknown[]) => {
            statements.push(sql);
            return (target.execute as (sql: string, params?: unknown[]) => unknown)(sql, params);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await getMonthView(s.ctx, spy, "2026-06", clock.now());
    expect(statements.filter((sql) => /FROM\s+appointment\b/i.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /FROM\s+calendar_block\b/i.test(sql))).toHaveLength(1);
  });

  it("con 300 citas y 20 bloqueos calcula el mes en menos de 2 segundos (SC-008)", async () => {
    const s = await scenario();
    const patient = await createPatient(pool);
    // Citas fuera del horario (después de las 20:00) para no alterar los horarios libres, con inicios distintos.
    for (let index = 0; index < 300; index += 1) {
      const day = String((index % 30) + 1).padStart(2, "0");
      const minutes = 20 * 60 + Math.floor(index / 30) * 5;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      await createAppointment(pool, { doctorId: s.doctorId, patientId: patient.patientId, startUtc: localAt(MX, `2026-06-${day}`, time) });
    }
    for (let index = 0; index < 20; index += 1) {
      const day = String(index + 1).padStart(2, "0");
      await createBlock(pool, { doctorId: s.doctorId, startUtc: localAt(MX, `2026-06-${day}`, "13:00"), endUtc: localAt(MX, `2026-06-${day}`, "14:00") });
    }
    const started = Date.now();
    const month = await getMonthView(s.ctx, pool, "2026-06", clock.now());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(month.days).toHaveLength(30);
  });
});

describe("día", () => {
  it("entrega los horarios en la hora del consultorio, con inicio y fin en UTC", async () => {
    const s = await scenario({ settings: { timezone: "America/Tijuana" } });
    const day = await getDayView(s.ctx, pool, "2026-06-16", clock.now());
    expect(day.timezone).toBe("America/Tijuana");
    expect(day.slots[0]?.startLocal).toBe("2026-06-16T09:00");
    expect(day.slots[0]?.startUtc.toISOString()).toBe("2026-06-16T16:00:00.000Z"); // Tijuana en verano: UTC−7
    expect(day.slots[0]?.endUtc.toISOString()).toBe("2026-06-16T16:45:00.000Z");
  });

  it("rechaza fechas pasadas, mal formadas o más allá de la anticipación máxima", async () => {
    const s = await scenario();
    for (const date of ["2026-06-14", "2026-02-30", "mañana", "2026-08-20"]) {
      await expect(getDayView(s.ctx, pool, date, clock.now())).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("el cambio de hora (primavera) no duplica ni pierde horarios", async () => {
    clock.set(new Date("2026-02-20T18:00:00.000Z"));
    const s = await scenario({ settings: { timezone: "America/Tijuana" }, hours: [{ weekday: 7, startMinute: 0, endMinute: 6 * 60 }] });
    const day = await getDayView(s.ctx, pool, "2026-03-08", clock.now()); // domingo: 2:00 no existe
    const starts = day.slots.map((slot) => slot.startUtc.getTime());
    expect(new Set(starts).size).toBe(starts.length);
    expect(day.slots.map((slot) => slot.startLocal.slice(11))).not.toContain("02:00");
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(day.slots.length).toBeGreaterThanOrEqual(4);
  });

  it("el cambio de hora (otoño) no duplica horarios", async () => {
    clock.set(new Date("2026-10-15T18:00:00.000Z"));
    const s = await scenario({ settings: { timezone: "America/Tijuana" }, hours: [{ weekday: 7, startMinute: 0, endMinute: 6 * 60 }] });
    const day = await getDayView(s.ctx, pool, "2026-11-01", clock.now());
    const starts = day.slots.map((slot) => slot.startUtc.getTime());
    expect(new Set(starts).size).toBe(starts.length);
    expect(day.slots.length).toBeGreaterThanOrEqual(5);
  });
});
