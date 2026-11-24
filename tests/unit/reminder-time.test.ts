import { describe, expect, it } from "vitest";
import { REMINDER_LEAD_HOURS, isReminderDue, reminderMoment } from "../../src/lib/reminder-time.js";

const HOUR = 3_600_000;
const START = new Date("2026-06-20T16:00:00.000Z");
const at = (hoursBeforeStart: number): Date => new Date(START.getTime() - hoursBeforeStart * HOUR);

describe("reminderMoment", () => {
  it("es 6 horas antes del límite de cancelación: 30 h con 24 h, 54 h con 48 h, 6 h con 0 h", () => {
    expect(REMINDER_LEAD_HOURS).toBe(6);
    expect(reminderMoment(START, 24).getTime()).toBe(at(30).getTime());
    expect(reminderMoment(START, 48).getTime()).toBe(at(54).getTime());
    expect(reminderMoment(START, 0).getTime()).toBe(at(6).getTime());
  });
});

describe("isReminderDue", () => {
  const appointment = { startUtc: START, createdAt: at(200) };

  it("es falso antes del momento del recordatorio", () => {
    expect(isReminderDue(at(31), appointment, 24)).toBe(false);
    expect(isReminderDue(new Date(at(30).getTime() - 1), appointment, 24)).toBe(false);
  });

  it("es verdadero desde ese momento y hasta el inicio de la cita", () => {
    expect(isReminderDue(at(30), appointment, 24)).toBe(true);
    expect(isReminderDue(at(12), appointment, 24)).toBe(true);
    expect(isReminderDue(new Date(START.getTime() - 1), appointment, 24)).toBe(true);
  });

  it("es falso cuando la cita ya empezó", () => {
    expect(isReminderDue(START, appointment, 24)).toBe(false);
    expect(isReminderDue(new Date(START.getTime() + HOUR), appointment, 24)).toBe(false);
  });

  it("es falso si la cita se creó después del momento del recordatorio (basta la confirmación)", () => {
    const late = { startUtc: START, createdAt: at(10) };
    expect(isReminderDue(at(5), late, 24)).toBe(false);
  });

  it("es verdadero si la cita se creó justo en el momento del recordatorio", () => {
    expect(isReminderDue(at(29), { startUtc: START, createdAt: at(30) }, 24)).toBe(true);
  });

  it("cambia con el límite de cancelación del consultorio", () => {
    expect(isReminderDue(at(40), appointment, 24)).toBe(false);
    expect(isReminderDue(at(40), appointment, 48)).toBe(true);
  });
});
