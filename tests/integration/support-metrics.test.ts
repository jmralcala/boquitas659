import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { signOpenedAt } from "../../src/lib/signed-timestamp.js";
import { recordBookingCompleted, recordBookingStarted } from "../../src/modules/site/metrics-hooks.js";
import {
  clearTables,
  createAppointment,
  createDoctor,
  createEmail,
  createMetricRow,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  WEEKDAY_HOURS,
  type CreatedDoctor,
} from "./helpers/db.js";
import { createSupportWithMfa, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let support: AuthedClient;
const NOW = new Date("2026-11-25T15:30:00.000Z"); // miércoles; la última semana completa empezó el 2026-11-16

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(NOW);
  await ensurePrivacyDocument(pool);
  support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const URGENT_OK = (doctor: CreatedDoctor, outcome: "ok" | "rejected", at: string) =>
  pool.execute(
    "INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', 'urgent_requested', ?, ?)",
    [doctor.doctorId, 1, outcome, new Date(at)],
  );
const staffAction = (doctor: CreatedDoctor, at: string) =>
  pool.execute(
    "INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'doctor', 'settings_updated', 'ok', ?)",
    [doctor.doctorId, doctor.user.id, new Date(at)],
  );

describe("métricas con datos conocidos", () => {
  it("cada cifra coincide con el cálculo manual", async () => {
    const a = await createDoctor(pool, { fullName: "Dra. Ana Uno" });
    const b = await createDoctor(pool, { fullName: "Dr. Beto Dos" });
    await pool.execute("UPDATE doctor SET approved_at = '2026-11-02 10:00:00.000'");

    // Reservas: 10 entradas, 8 completadas; 6 con duración (3 menores a 2 min), suma 600 s.
    await createMetricRow(pool, a.doctorId, "2026-11-24", { started: 6, completed: 5, durationSum: 400, durationCount: 4, underTarget: 2 });
    await createMetricRow(pool, b.doctorId, "2026-11-24", { started: 4, completed: 3, durationSum: 200, durationCount: 2, underTarget: 1 });
    // Fuera del periodo de la última semana (pero dentro de las 4 semanas).
    await createMetricRow(pool, a.doctorId, "2026-11-05", { started: 10, completed: 2 });

    // Correos del periodo: 9 enviados, 1 fallido, 2 en cola.
    const inWeek = new Date("2026-11-24T10:00:00.000Z");
    for (let i = 0; i < 9; i += 1) await createEmail(pool, { status: "sent", createdAt: inWeek });
    await createEmail(pool, { status: "failed", createdAt: inWeek });
    await createEmail(pool, { status: "queued", createdAt: inWeek });
    await createEmail(pool, { status: "queued", createdAt: inWeek });

    // Urgencias: 3 agendadas y 1 sin espacio.
    for (let i = 0; i < 3; i += 1) await URGENT_OK(a, "ok", "2026-11-24T12:00:00.000Z");
    await URGENT_OK(b, "rejected", "2026-11-24T13:00:00.000Z");

    // Citas por semana: 2 del médico A y 1 del B (semana del 23), más una cancelada que no cuenta.
    const patient = await createPatient(pool, { fullName: "Paciente Reconocible Única" });
    await createAppointment(pool, { doctorId: a.doctorId, patientId: patient.patientId, startUtc: new Date("2026-11-24T16:00:00.000Z") });
    await createAppointment(pool, { doctorId: a.doctorId, patientId: patient.patientId, startUtc: new Date("2026-11-24T17:00:00.000Z") });
    await createAppointment(pool, { doctorId: b.doctorId, patientId: patient.patientId, startUtc: new Date("2026-11-24T18:00:00.000Z") });
    await createAppointment(pool, { doctorId: b.doctorId, patientId: patient.patientId, startUtc: new Date("2026-11-24T19:00:00.000Z"), status: "cancelled" });

    // Uso: A activo en las dos últimas semanas completas (16 y 9 de noviembre no, ver abajo); B solo en una.
    await staffAction(a, "2026-11-10T10:00:00.000Z"); // semana del 9
    await staffAction(a, "2026-11-17T10:00:00.000Z"); // semana del 16
    await staffAction(b, "2026-11-17T10:00:00.000Z"); // B solo en la semana del 16

    const week = await t.services.metrics.compute("semana");
    expect(week.booking).toMatchObject({ started: 10, completed: 8, completionPercent: 80, meetsCompletion: true, averageSeconds: 100, meetsTime: true, underTargetPercent: 50 });
    expect(week.mail).toMatchObject({ sent: 9, failed: 1, deliveredPercent: 90, meetsTarget: false });
    expect(week.urgent).toEqual({ scheduled: 3, noSpace: 1, scheduledPercent: 75 });
    expect(week.appointmentsPerDoctorWeek).toEqual([
      { week: "2026-11-23", doctorId: a.doctorId, doctorName: "Dra. Ana Uno", count: 2 },
      { week: "2026-11-23", doctorId: b.doctorId, doctorName: "Dr. Beto Dos", count: 1 },
    ]);
    expect(week.sustainedUse).toEqual({ approvedDoctors: 2, activeBothWeeks: 1, percent: 50, meetsTarget: true });

    const month = await t.services.metrics.compute("4semanas");
    expect(month.booking).toMatchObject({ started: 20, completed: 10, completionPercent: 50, meetsCompletion: false });
    expect(month.activeDoctorsPerWeek).toEqual([
      { week: "2026-11-09", count: 1 },
      { week: "2026-11-16", count: 2 },
    ]);
    expect((await t.services.metrics.compute("piloto")).from.toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });

  it("un periodo sin datos devuelve «sin datos» (nulos), no ceros ni errores", async () => {
    const metrics = await t.services.metrics.compute("semana");
    expect(metrics.booking).toMatchObject({ started: 0, completed: 0, completionPercent: null, meetsCompletion: null, averageSeconds: null, meetsTime: null, underTargetPercent: null });
    expect(metrics.mail).toMatchObject({ deliveredPercent: null, meetsTarget: null });
    expect(metrics.urgent).toEqual({ scheduled: 0, noSpace: 0, scheduledPercent: null });
    expect(metrics.appointmentsPerDoctorWeek).toEqual([]);
    expect(metrics.sustainedUse).toMatchObject({ percent: null, meetsTarget: null });
  });

  it("ni el HTML ni el JSON de la pantalla contienen nombres de pacientes, correos, teléfonos ni categoría", async () => {
    const doctor = await createDoctor(pool, { fullName: "Dra. Visible" });
    const patient = await createPatient(pool, { fullName: "Paciente Reconocible Única", email: "paciente.privado@example.com" });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-11-24T16:00:00.000Z") });
    await createEmail(pool, { status: "failed", createdAt: new Date("2026-11-24T10:00:00.000Z"), to: "otro.privado@example.com", payload: { category: "naranja" } });
    await URGENT_OK(doctor, "ok", "2026-11-24T12:00:00.000Z");
    for (const accept of ["text/html", "application/json"]) {
      const response = await t.app.inject({ method: "GET", url: "/soporte/metricas?periodo=4semanas", remoteAddress: uniqueIp(), headers: { cookie: support.cookie, accept } });
      expect(response.statusCode).toBe(200);
      for (const forbidden of ["Paciente Reconocible Única", "paciente.privado@example.com", "otro.privado", "naranja", "5598765432"]) {
        expect(response.body, `${accept} ${forbidden}`).not.toContain(forbidden);
      }
      expect(response.body).toContain("Dra. Visible");
    }
  });
});

describe("contadores de reserva", () => {
  it("20 reservas simultáneas suman exacto, sin perder incrementos", async () => {
    const doctor = await createDoctor(pool);
    await Promise.all(Array.from({ length: 20 }, () => recordBookingStarted(pool, doctor.doctorId, NOW)));
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordBookingCompleted(pool, doctor.doctorId, NOW, index % 2 === 0 ? 60 : 180)));
    expect((await rows("SELECT started, completed, duration_sum_seconds AS sum, duration_count AS count, under_target_count AS under FROM pilot_metric_daily"))[0]).toEqual({
      started: 20,
      completed: 20,
      sum: 10 * 60 + 10 * 180,
      count: 20,
      under: 10,
    });
  });

  it("una duración nula cuenta la reserva pero no entra en el tiempo; 120 s exactos no cumplen la meta", async () => {
    const doctor = await createDoctor(pool);
    await recordBookingCompleted(pool, doctor.doctorId, NOW, null);
    await recordBookingCompleted(pool, doctor.doctorId, NOW, 120);
    expect((await rows("SELECT completed, duration_count AS count, under_target_count AS under FROM pilot_metric_daily"))[0]).toEqual({ completed: 2, count: 1, under: 0 });
  });
});

describe("la reserva real alimenta los contadores", () => {
  async function bookingWorld() {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: WEEKDAY_HOURS });
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const session = await t.services.sessions.validate(client.cookie.split("=")[1] ?? "");
    return { doctor, patient, client, secret: session?.csrfSecret ?? "" };
  }
  const book = (w: Awaited<ReturnType<typeof bookingWorld>>, extra: Record<string, string>) =>
    postForm(t.app, "/c/clinica-rios/reservar", { _csrf: w.client.csrf, inicio: "2026-11-26T10:00", patientId: String(w.patient.patientId), autorizo: "yes", ...extra }, w.client.cookie);
  const counters = async () => (await rows("SELECT started, completed, duration_count AS count, duration_sum_seconds AS sum FROM pilot_metric_daily"))[0];

  it("entrar a la pantalla cuenta una vez; navegar con el enlace firmado no vuelve a contar; reservar suma la duración", async () => {
    const w = await bookingWorld();
    const entry = await t.app.inject({ method: "GET", url: "/c/clinica-rios/reservar?fecha=2026-11-26", remoteAddress: uniqueIp(), headers: { cookie: w.client.cookie } });
    expect(entry.statusCode).toBe(200);
    expect(await counters()).toMatchObject({ started: 1, completed: 0 });
    const token = /name="abierto" value="([^"]+)"/.exec(entry.body)?.[1] ?? /[?&]a=([^"&]+)/.exec(entry.body)?.[1];
    expect(token).toBeTruthy();

    // Con el enlace firmado (otro día) no se cuenta otra entrada.
    await t.app.inject({ method: "GET", url: `/c/clinica-rios/reservar?fecha=2026-11-27&a=${encodeURIComponent(String(token))}`, remoteAddress: uniqueIp(), headers: { cookie: w.client.cookie } });
    expect(await counters()).toMatchObject({ started: 1 });

    t.clock.set(new Date(NOW.getTime() + 75_000));
    const response = await book(w, { abierto: String(token) });
    expect(response.statusCode).toBe(303);
    expect(await counters()).toMatchObject({ started: 1, completed: 1, count: 1, sum: 75 });
  });

  it("sin firma o con firma inválida la reserva cuenta como completada pero no entra en la duración", async () => {
    const w = await bookingWorld();
    expect((await book(w, {})).statusCode).toBe(303);
    expect(await counters()).toMatchObject({ completed: 1, count: 0, sum: 0 });
    const w2Token = signOpenedAt("otro-secreto".repeat(4), NOW);
    const second = await createPatient(pool);
    const client2 = await sessionFor(t.services, second.user);
    const response = await postForm(t.app, "/c/clinica-rios/reservar", { _csrf: client2.csrf, inicio: "2026-11-26T11:00", patientId: String(second.patientId), autorizo: "yes", abierto: w2Token }, client2.cookie);
    expect(response.statusCode).toBe(303);
    expect(await counters()).toMatchObject({ completed: 2, count: 0 });
  });

  it("una reserva rechazada no cuenta como completada", async () => {
    const w = await bookingWorld();
    const response = await book(w, { inicio: "2026-11-26T03:00" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect((await rows("SELECT completed FROM pilot_metric_daily")).every((row) => Number(row.completed) === 0)).toBe(true);
    expect(createPatientContext(w.doctor.doctorId, w.patient.user.id).doctorId).toBe(w.doctor.doctorId);
  });
});

describe("señal de abuso de urgencias", () => {
  it("cuenta pacientes con más de una urgencia vigente y cuentas con más de 3 solicitudes en 24 h, sin identificarlos", async () => {
    const a = await createDoctor(pool);
    const b = await createDoctor(pool);
    const abuser = await createPatient(pool, { fullName: "Paciente Abusivo Reconocible", email: "abusivo@example.com" });
    const normal = await createPatient(pool);
    // Dos urgencias vigentes del mismo paciente en consultorios distintos; una vigente de otro; una pasada.
    await createAppointment(pool, { doctorId: a.doctorId, patientId: abuser.patientId, startUtc: new Date("2026-11-26T16:00:00.000Z"), kind: "urgent" });
    await createAppointment(pool, { doctorId: b.doctorId, patientId: abuser.patientId, startUtc: new Date("2026-11-26T17:00:00.000Z"), kind: "urgent" });
    await createAppointment(pool, { doctorId: a.doctorId, patientId: normal.patientId, startUtc: new Date("2026-11-26T18:00:00.000Z"), kind: "urgent" });
    await createAppointment(pool, { doctorId: a.doctorId, patientId: normal.patientId, startUtc: new Date("2026-11-20T18:00:00.000Z"), kind: "urgent" });
    // Una cuenta con 4 solicitudes en las últimas 24 h y otra con 3.
    for (let index = 0; index < 4; index += 1) await pool.execute("INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', 'urgent_requested', 'ok', ?)", [a.doctorId, abuser.user.id, new Date("2026-11-25T10:00:00.000Z")]);
    for (let index = 0; index < 3; index += 1) await pool.execute("INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', 'urgent_requested', 'ok', ?)", [a.doctorId, normal.user.id, new Date("2026-11-25T10:00:00.000Z")]);
    // Solicitudes de hace más de 24 h no cuentan.
    for (let index = 0; index < 5; index += 1) await pool.execute("INSERT INTO calendar_action_log (doctor_id, actor_user_id, actor_role, action, outcome, occurred_at) VALUES (?, ?, 'patient', 'urgent_requested', 'ok', ?)", [b.doctorId, 999, new Date("2026-11-20T10:00:00.000Z")]);

    const metrics = await t.services.metrics.compute("semana");
    expect(metrics.urgentAbuse).toEqual({ patientsWithSeveralActive: 1, accountsOverRequestLimit: 1 });
    const response = await t.app.inject({ method: "GET", url: "/soporte/metricas", remoteAddress: uniqueIp(), headers: { cookie: support.cookie } });
    expect(response.body).toContain("1 pacientes con más de una urgencia vigente");
    expect(response.body).toContain("⚠ revisar");
    expect(response.body).not.toContain("Paciente Abusivo Reconocible");
    expect(response.body).not.toContain("abusivo@example.com");
  });

  it("sin señales muestra cero y «sin señales»", async () => {
    expect((await t.services.metrics.compute("semana")).urgentAbuse).toEqual({ patientsWithSeveralActive: 0, accountsOverRequestLimit: 0 });
    const response = await t.app.inject({ method: "GET", url: "/soporte/metricas", remoteAddress: uniqueIp(), headers: { cookie: support.cookie } });
    expect(response.body).toContain("✓ sin señales");
  });
});
