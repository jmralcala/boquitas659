import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { getDayView, getMonthView } from "../../src/modules/site/availability-view.js";
import {
  clearTables,
  createAppointment,
  createCalendarHours,
  createCalendarSettings,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
} from "./helpers/db.js";
import { agendaClientFor, createTestApp, localAt, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const MX = "America/Mexico_City";
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const TUESDAY = "2026-06-16";

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function get(url: string, client: AuthedClient, accept = "application/json") {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept } });
}

/** Martes: regular 9:00–11:00 (9:00 y 10:00) y urgencia 8:00–9:00 (8:00). */
const MIXED_HOURS = [
  { weekday: 2, startMinute: 9 * 60, endMinute: 11 * 60 },
  { weekday: 2, startMinute: 8 * 60, endMinute: 9 * 60, kind: "urgent" as const },
];

describe("el calendario convencional del paciente no ve los espacios de urgencia", () => {
  it("el día y el mes solo ofrecen los espacios regulares", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { hours: MIXED_HOURS });
    const patient = await createPatient(pool);
    const ctx = createPatientContext(doctor.doctorId, patient.user.id);
    const day = await getDayView(ctx, pool, TUESDAY, NOW);
    expect(day.slots.map((slot) => slot.startLocal.slice(11))).toEqual(["09:00", "10:00"]);
    const month = await getMonthView(ctx, pool, "2026-06", NOW);
    expect(month.days.find((entry) => entry.date === TUESDAY)?.freeCount).toBe(2);
  });

  it("un día que solo tiene franja de urgencia aparece deshabilitado en el mes", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { hours: [{ weekday: 3, startMinute: 8 * 60, endMinute: 9 * 60, kind: "urgent" }] });
    const patient = await createPatient(pool);
    const ctx = createPatientContext(doctor.doctorId, patient.user.id);
    const month = await getMonthView(ctx, pool, "2026-06", NOW);
    expect(month.days.find((entry) => entry.date === "2026-06-17")?.enabled).toBe(false);
  });

  it("la pantalla de reserva (HTML) no ofrece el horario de urgencia", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: MIXED_HOURS });
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const response = await get(`/c/clinica-rios/reservar?fecha=${TUESDAY}`, client, "text/html");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`value="${TUESDAY}T09:00"`);
    expect(response.body).toContain(`value="${TUESDAY}T10:00"`);
    expect(response.body).not.toContain(`value="${TUESDAY}T08:00"`);
  });
});

describe("la agenda del personal marca las urgencias", () => {
  async function seed() {
    const agenda = await agendaClientFor(t, pool, "doctor");
    await createCalendarSettings(pool, agenda.doctor.doctorId);
    await createCalendarHours(pool, agenda.doctor.doctorId, MIXED_HOURS);
    const patient = await createPatient(pool, { fullName: "Mario Quintana" });
    return { ...agenda, patient };
  }

  it("el día muestra los espacios de urgencia con su tipo y los regulares como regular", async () => {
    const s = await seed();
    const json = (await get(`/agenda/dia/${TUESDAY}`, s.client)).json() as { slots: { start: string; kind: string }[] };
    expect(json.slots.map((slot) => `${slot.start.slice(11)} ${slot.kind}`)).toEqual(["08:00 urgent", "09:00 regular", "10:00 regular"]);
  });

  it("una cita de urgencia dentro de la franja de urgencia lleva su tipo y NO se marca como fuera del horario", async () => {
    const s = await seed();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, TUESDAY, "08:00"), kind: "urgent", createdByRole: "patient", createdByUserId: s.patient.user.id });
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, TUESDAY, "09:00") });
    const json = (await get(`/agenda/dia/${TUESDAY}`, s.client)).json() as { appointments: { kind: string; outOfSchedule: boolean }[]; slots: { state: string }[] };
    expect(json.appointments.map((appointment) => `${appointment.kind} ${appointment.outOfSchedule}`)).toEqual(["urgent false", "regular false"]);
    expect(json.slots.slice(0, 2).map((slot) => slot.state)).toEqual(["booked", "booked"]);
  });

  it("en HTML el día y la semana muestran la etiqueta «Urgencia» en el espacio y en la cita; recepción la ve igual", async () => {
    const s = await seed();
    await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, TUESDAY, "08:00"), kind: "urgent", createdByRole: "patient", createdByUserId: s.patient.user.id });
    const reception = await agendaClientFor(t, pool, "reception", { doctor: s.doctor });
    for (const client of [s.client, reception.client]) {
      const day = await get(`/agenda/dia/${TUESDAY}`, client, "text/html");
      expect(day.body).toContain("Urgencia");
      const week = await get(`/agenda/semana/${TUESDAY}`, client, "text/html");
      expect(week.body).toContain("Urgencia");
    }
    // La categoría no existe en la agenda: solo el tipo.
    const html = (await get(`/agenda/dia/${TUESDAY}`, s.client, "text/html")).body.toLowerCase();
    for (const id of ["rojo", "naranja", "amarillo", "verde_claro"]) expect(html).not.toContain(id);
  });

  it("el detalle de la cita muestra el tipo en HTML y en JSON", async () => {
    const s = await seed();
    const urgent = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, TUESDAY, "08:00"), kind: "urgent", createdByRole: "patient", createdByUserId: s.patient.user.id });
    const regular = await createAppointment(pool, { doctorId: s.doctor.doctorId, patientId: s.patient.patientId, startUtc: localAt(MX, TUESDAY, "09:00") });
    expect(((await get(`/agenda/citas/${urgent}`, s.client)).json() as { kind: string }).kind).toBe("urgent");
    expect(((await get(`/agenda/citas/${regular}`, s.client)).json() as { kind: string }).kind).toBe("regular");
    expect((await get(`/agenda/citas/${urgent}`, s.client, "text/html")).body).toContain("Urgencia");
    expect((await get(`/agenda/citas/${regular}`, s.client, "text/html")).body).toContain("Convencional");
  });
});
