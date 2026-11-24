import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/http/errors.js";
import { createTenantContext } from "../../src/lib/tenant.js";
import { getDay, getWeek } from "../../src/modules/calendar/agenda-service.js";
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
} from "./helpers/db.js";
import { localAt } from "./helpers/app.js";

const pool = createTestPool();
const MX = "America/Mexico_City";
// Lunes 15 de junio de 2026, 11:00 hora de Ciudad de México (17:00Z): los espacios de 9:00, 10:00 y 11:00 ya empezaron.
const NOW = new Date("2026-06-15T17:00:00.000Z");
const MONDAY = "2026-06-15";

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

const hm = (hours: number, minutes = 0): number => hours * 60 + minutes;

async function setup(options: { hours?: { weekday: number; startMinute: number; endMinute: number }[]; timezone?: string } = {}) {
  const doctor = await createDoctor(pool);
  await createCalendarSettings(pool, doctor.doctorId, { timezone: options.timezone ?? MX });
  await createCalendarHours(pool, doctor.doctorId, options.hours ?? [{ weekday: 1, startMinute: hm(9), endMinute: hm(14) }]);
  const ctx = createTenantContext(doctor.doctorId, { kind: "doctor", userId: doctor.user.id });
  return { doctor, ctx };
}

describe("getDay", () => {
  it("muestra cada espacio con su estado: pasado, ocupado, bloqueado y libre", async () => {
    const { doctor, ctx } = await setup();
    const patient = await createPatient(pool, { fullName: "Ana Pérez" });
    // Espacios del lunes (45 + 15): 9:00, 10:00, 11:00, 12:00, 13:00. Ahora son las 11:00 locales.
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "12:00") });
    await createBlock(pool, { doctorId: doctor.doctorId, startUtc: localAt(MX, MONDAY, "13:00"), endUtc: localAt(MX, MONDAY, "14:00") });

    const day = await getDay(ctx, pool, MONDAY, NOW);
    expect(day.timezone).toBe(MX);
    expect(day.date).toBe(MONDAY);
    expect(day.slots.map((slot) => slot.state)).toEqual(["past", "past", "past", "booked", "blocked"]);
    expect(day.slots[3]?.appointmentId).toBeDefined();
  });

  it("la cita muestra el nombre del paciente y ningún otro dato", async () => {
    const { doctor, ctx } = await setup();
    const patient = await createPatient(pool, { fullName: "Ana Pérez", email: "ana@example.com" });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "12:00") });

    const day = await getDay(ctx, pool, MONDAY, NOW);
    expect(day.appointments).toHaveLength(1);
    const appointment = day.appointments[0];
    expect(appointment?.patientName).toBe("Ana Pérez");
    expect(Object.keys(appointment ?? {}).sort()).toEqual(["endUtc", "id", "kind", "outOfSchedule", "patientId", "patientName", "startUtc"]);
    expect(JSON.stringify(day)).not.toContain("ana@example.com");
    expect(JSON.stringify(day)).not.toContain("5512345678");
  });

  it("una cita fuera del horario actual sigue apareciendo, marcada", async () => {
    const { doctor, ctx } = await setup();
    const patient = await createPatient(pool);
    // 20:00 no está en el horario (9–14); también una cita con otra duración en un inicio válido.
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "20:00") });
    await createAppointment(pool, {
      doctorId: doctor.doctorId,
      patientId: patient.patientId,
      startUtc: localAt(MX, MONDAY, "13:00"),
      endUtc: localAt(MX, MONDAY, "13:30"),
    });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "12:00") });

    const day = await getDay(ctx, pool, MONDAY, NOW);
    expect(day.appointments.map((a) => a.outOfSchedule)).toEqual([false, true, true]);
  });

  it("una cita cancelada no aparece ni ocupa el espacio", async () => {
    const { doctor, ctx } = await setup();
    const patient = await createPatient(pool);
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, MONDAY, "12:00"), status: "cancelled" });
    const day = await getDay(ctx, pool, MONDAY, NOW);
    expect(day.appointments).toEqual([]);
    expect(day.slots[3]?.state).toBe("free");
  });

  it("un día sin franjas no tiene espacios", async () => {
    const { ctx } = await setup();
    const day = await getDay(ctx, pool, "2026-06-16", NOW); // martes
    expect(day.slots).toEqual([]);
  });

  it("una cita que se solapa con un espacio de otra hora lo ocupa (cambio de duración)", async () => {
    const { doctor, ctx } = await setup();
    const patient = await createPatient(pool);
    await createAppointment(pool, {
      doctorId: doctor.doctorId,
      patientId: patient.patientId,
      startUtc: localAt(MX, MONDAY, "11:30"),
      endUtc: localAt(MX, MONDAY, "12:15"),
    });
    // El espacio de las 12:00 (12:00–12:45) se solapa con 11:30–12:15.
    const day = await getDay(ctx, pool, MONDAY, NOW);
    expect(day.slots[3]?.state).toBe("booked");
  });

  it("incluye la fecha anterior y la siguiente para navegar", async () => {
    const { ctx } = await setup();
    const day = await getDay(ctx, pool, MONDAY, NOW);
    expect(day.previousDate).toBe("2026-06-14");
    expect(day.nextDate).toBe("2026-06-16");
  });

  it("usa la zona horaria del consultorio para decidir el día", async () => {
    const { doctor, ctx } = await setup({ timezone: "America/Tijuana", hours: [{ weekday: 1, startMinute: hm(21), endMinute: hm(24) }] });
    const patient = await createPatient(pool);
    // 22:00 del lunes en Tijuana (UTC−7) es martes 05:00Z: el día local sigue siendo lunes.
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt("America/Tijuana", MONDAY, "22:00") });
    const monday = await getDay(ctx, pool, MONDAY, new Date("2026-06-14T12:00:00.000Z"));
    expect(monday.appointments).toHaveLength(1);
    const tuesday = await getDay(ctx, pool, "2026-06-16", new Date("2026-06-14T12:00:00.000Z"));
    expect(tuesday.appointments).toEqual([]);
  });

  describe("rango de fechas permitido", () => {
    it("acepta hasta 730 días hacia adelante y 365 hacia atrás, y rechaza más allá", async () => {
      const { ctx } = await setup();
      // Hoy local = 2026-06-15.
      await expect(getDay(ctx, pool, "2028-06-14", NOW)).resolves.toBeDefined(); // +730
      await expect(getDay(ctx, pool, "2028-06-15", NOW)).rejects.toBeInstanceOf(ValidationError); // +731
      await expect(getDay(ctx, pool, "2025-06-15", NOW)).resolves.toBeDefined(); // −365
      await expect(getDay(ctx, pool, "2025-06-14", NOW)).rejects.toBeInstanceOf(ValidationError); // −366
    });

    it("rechaza una fecha inexistente", async () => {
      const { ctx } = await setup();
      await expect(getDay(ctx, pool, "2026-02-30", NOW)).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

describe("getWeek", () => {
  const FULL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: hm(9), endMinute: hm(11) }));

  it("trae siete días de lunes a domingo, desde cualquier fecha de la semana", async () => {
    const { ctx } = await setup({ hours: FULL_WEEK });
    const fromWednesday = await getWeek(ctx, pool, "2026-06-17", NOW);
    expect(fromWednesday.days.map((d) => d.date)).toEqual([
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
    ]);
    expect(fromWednesday.startDate).toBe("2026-06-15");
    const fromSunday = await getWeek(ctx, pool, "2026-06-21", NOW);
    expect(fromSunday.startDate).toBe("2026-06-15");
  });

  it("cada día trae sus espacios, citas y bloqueos", async () => {
    const { doctor, ctx } = await setup({ hours: FULL_WEEK });
    const patient = await createPatient(pool, { fullName: "Luis Gómez" });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: localAt(MX, "2026-06-17", "09:00") });
    await createBlock(pool, { doctorId: doctor.doctorId, startUtc: localAt(MX, "2026-06-18", "00:00"), endUtc: localAt(MX, "2026-06-19", "00:00") });

    const week = await getWeek(ctx, pool, MONDAY, NOW);
    const wednesday = week.days[2];
    const thursday = week.days[3];
    expect(wednesday?.appointments.map((a) => a.patientName)).toEqual(["Luis Gómez"]);
    expect(wednesday?.slots.map((s) => s.state)).toEqual(["booked", "free"]);
    expect(thursday?.slots.map((s) => s.state)).toEqual(["blocked", "blocked"]);
    expect(thursday?.blocks).toHaveLength(1);
    expect(week.days[0]?.slots.map((s) => s.state)).toEqual(["past", "past"]);
  });

  it("navega a la semana anterior y a la siguiente", async () => {
    const { ctx } = await setup({ hours: FULL_WEEK });
    const week = await getWeek(ctx, pool, "2026-06-17", NOW);
    expect(week.previousDate).toBe("2026-06-08");
    expect(week.nextDate).toBe("2026-06-22");
  });

  it("un día de la semana sin franja no tiene espacios pero sigue en la lista", async () => {
    const { ctx } = await setup(); // solo lunes
    const week = await getWeek(ctx, pool, MONDAY, NOW);
    expect(week.days).toHaveLength(7);
    expect(week.days.slice(1).every((d) => d.slots.length === 0)).toBe(true);
  });

  it("300 citas en una semana se cargan en menos de 2 segundos", async () => {
    const { doctor, ctx } = await setup({ hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) });
    await pool.execute("UPDATE calendar_settings SET slot_minutes = 15, gap_minutes = 0 WHERE doctor_id = ?", [doctor.doctorId]);
    const patient = await createPatient(pool, { fullName: "Paciente Masivo" });
    await pool.execute("INSERT INTO doctor_patient (doctor_id, patient_id) VALUES (?, ?)", [doctor.doctorId, patient.patientId]);
    const monday = localAt(MX, MONDAY, "00:00").getTime();
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const start = new Date(monday + index * 15 * 60_000 * 2); // un espacio sí y otro no
      placeholders.push("(?, ?, ?, ?, 'booked', ?, 'doctor', UTC_TIMESTAMP(3))");
      values.push(doctor.doctorId, patient.patientId, start, new Date(start.getTime() + 15 * 60_000), doctor.user.id);
    }
    await pool.execute(
      `INSERT INTO appointment (doctor_id, patient_id, start_utc, end_utc, status, created_by_user_id, created_by_role, created_at) VALUES ${placeholders.join(", ")}`,
      values as never[],
    );

    const started = performance.now();
    const week = await getWeek(ctx, pool, MONDAY, new Date("2026-06-14T12:00:00.000Z"));
    const elapsed = performance.now() - started;
    expect(week.days.reduce((sum, day) => sum + day.appointments.length, 0)).toBe(300);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("aislamiento entre médicos", () => {
  it("citas, bloqueos y nombres de otro médico nunca aparecen", async () => {
    const a = await setup();
    const b = await setup();
    const patientA = await createPatient(pool, { fullName: "Paciente de A" });
    const patientB = await createPatient(pool, { fullName: "Paciente de B" });
    await createAppointment(pool, { doctorId: a.doctor.doctorId, patientId: patientA.patientId, startUtc: localAt(MX, MONDAY, "12:00") });
    await createAppointment(pool, { doctorId: b.doctor.doctorId, patientId: patientB.patientId, startUtc: localAt(MX, MONDAY, "13:00") });
    await createBlock(pool, { doctorId: b.doctor.doctorId, startUtc: localAt(MX, MONDAY, "10:00"), endUtc: localAt(MX, MONDAY, "11:00") });

    const forA = await getDay(a.ctx, pool, MONDAY, new Date("2026-06-14T12:00:00.000Z"));
    expect(forA.appointments.map((x) => x.patientName)).toEqual(["Paciente de A"]);
    expect(forA.blocks).toEqual([]);
    expect(forA.slots.map((s) => s.state)).toEqual(["free", "free", "free", "booked", "free"]);
    expect(JSON.stringify(forA)).not.toContain("Paciente de B");

    const weekForB = await getWeek(b.ctx, pool, MONDAY, new Date("2026-06-14T12:00:00.000Z"));
    expect(JSON.stringify(weekForB)).not.toContain("Paciente de A");
  });
});
