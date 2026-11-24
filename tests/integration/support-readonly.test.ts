import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SiteUnavailableError } from "../../src/http/errors.js";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { requestUrgent } from "../../src/modules/urgent/urgent-service.js";
import {
  clearTables,
  createAppointment,
  createDoctor,
  createPatient,
  createPublishedSite,
  createTestPool,
  ensurePrivacyDocument,
  resetDatabase,
  setAccountState,
  WEEKDAY_HOURS,
  type AccountState,
} from "./helpers/db.js";
import { agendaClientFor, createTestApp, postForm, sessionFor, uniqueIp, type TestApp } from "./helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México
const registered: { method: string; url: string }[] = [];

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, {}, {
    onRoute: (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== "HEAD" && method !== "OPTIONS") registered.push({ method, url: route.url });
      }
    },
  });
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

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const URGENT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 14 * 60, endMinute: 16 * 60, kind: "urgent" as const }));

async function clinic(state: AccountState) {
  const doctor = await createDoctor(pool);
  await createPublishedSite(pool, doctor, { slug: "clinica-rios", hours: [...WEEKDAY_HOURS, ...URGENT_HOURS] });
  await setAccountState(pool, doctor.doctorId, state);
  return doctor;
}

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie, accept: "application/json" } });
const concrete = (url: string): string => url.replace(/:token/g, "a".repeat(43)).replace(/:[A-Za-z]+/g, "1");

describe("solo lectura: el médico y su recepción consultan pero no cambian nada", () => {
  it.each(["doctor", "reception"] as const)("%s: GET de la agenda es 200 y las escrituras son 403", async (role) => {
    const doctor = await clinic("read_only");
    const staff = await agendaClientFor(t, pool, role, { doctor });
    expect((await get("/agenda/dia/2026-06-16", staff.client.cookie)).statusCode).toBe(200);

    const attempts: Array<[string, Record<string, string>]> = [
      ["/agenda/citas", { startLocal: "2026-06-16T10:00" }],
      ["/agenda/citas/1/cancelar", {}],
      ["/agenda/bloqueos", { date: "2026-06-17" }],
      ["/agenda/bloqueos/espacio", {}],
      ["/agenda/bloqueos/1/eliminar", {}],
      ["/agenda/configuracion", { slotMinutes: "45" }],
      ["/agenda/citas/buscar", { q: "ana" }],
    ];
    for (const [url, fields] of attempts) {
      const response = await postForm(t.app, url, { _csrf: staff.client.csrf, ...fields }, staff.client.cookie);
      expect(response.statusCode, `${role} ${url}`).toBe(403);
    }
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
    expect(await rows("SELECT id FROM calendar_block")).toEqual([]);
  });

  it("el médico no publica, despublica ni invita a recepción; el estado activo sí lo permite", async () => {
    const doctor = await clinic("read_only");
    const owner = await sessionFor(t.services, doctor.user);
    const writes = ["/medicos/micrositio/despublicar", "/medicos/micrositio/publicar", "/medicos/recepcion/invitar"];
    for (const url of writes) {
      const response = await postForm(t.app, url, { _csrf: owner.csrf, email: "nueva.persona@example.com" }, owner.cookie);
      expect(response.statusCode, url).toBe(403);
    }
    expect((await rows("SELECT status FROM doctor_site WHERE doctor_id = ?", [doctor.doctorId]))[0]?.status).toBe("published");
    await setAccountState(pool, doctor.doctorId, "active");
    expect((await postForm(t.app, "/medicos/micrositio/despublicar", { _csrf: owner.csrf }, owner.cookie)).statusCode).toBe(303);
  });

  it("ninguna ruta de escritura de la agenda, el micrositio o la recepción escapa al rechazo", async () => {
    const doctor = await clinic("active");
    const staff = await agendaClientFor(t, pool, "doctor", { doctor });
    const writes = registered.filter(
      (route) =>
        route.method === "POST" &&
        (route.url.startsWith("/agenda/") || route.url.startsWith("/medicos/micrositio") || route.url.startsWith("/medicos/recepcion")) &&
        !/\/logo$/.test(route.url), // carga de archivos: usa multipart y pasa por el mismo resolutor
    );
    expect(writes.length).toBeGreaterThanOrEqual(12);
    await setAccountState(pool, doctor.doctorId, "read_only");
    for (const route of writes) {
      const response = await postForm(t.app, concrete(route.url), { _csrf: staff.client.csrf }, staff.client.cookie);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });
});

describe("solo lectura: el micrositio no acepta reservas ni urgencias", () => {
  it("reservar y pedir una urgencia se rechazan con SiteUnavailableError", async () => {
    const doctor = await clinic("read_only");
    const patient = await createPatient(pool);
    const ctx = createPatientContext(doctor.doctorId, patient.user.id);
    const deps = { db: pool, clock: t.clock };
    await expect(reserveAsPatient(ctx, deps, { startLocal: "2026-06-16T10:00", patientId: patient.patientId, authorize: true })).rejects.toBeInstanceOf(SiteUnavailableError);
    await expect(requestUrgent(ctx, deps, { patientId: patient.patientId, category: "naranja", authorize: true })).rejects.toBeInstanceOf(SiteUnavailableError);
    expect(await rows("SELECT id FROM appointment")).toEqual([]);
  });

  it("la página pública pide confirmar por teléfono en solo lectura y vuelve a ofrecer reservas al reactivar", async () => {
    const doctor = await clinic("read_only");
    expect((await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp() })).body).toContain("no está recibiendo reservas");
    await setAccountState(pool, doctor.doctorId, "active");
    expect((await t.app.inject({ method: "GET", url: "/c/clinica-rios", remoteAddress: uniqueIp() })).body).not.toContain("no está recibiendo reservas");
  });
});

describe("solo lectura y suspensión: el paciente sigue cancelando", () => {
  it.each(["read_only", "suspended"] as const)("con la cuenta en %s la cancelación del paciente procede y el espacio queda libre", async (state) => {
    const doctor = await clinic("active");
    const patient = await createPatient(pool);
    const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-20T16:00:00.000Z") });
    await setAccountState(pool, doctor.doctorId, state);
    const client = await sessionFor(t.services, patient.user);
    const response = await postForm(t.app, `/pacientes/citas/${id}/cancelar`, { _csrf: client.csrf }, client.cookie);
    expect(response.statusCode).toBeLessThan(400);
    expect((await rows("SELECT status FROM appointment WHERE id = ?", [id]))[0]?.status).toBe("cancelled");
  });

  it("las citas futuras se conservan al cambiar de estado", async () => {
    const doctor = await clinic("active");
    const patient = await createPatient(pool);
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-20T16:00:00.000Z") });
    const supportId = (await createPatient(pool)).user.id; // cualquier usuario sirve de autor en la base de pruebas
    await t.services.accountState.setReadOnly({ doctorId: doctor.doctorId, supportUserId: supportId, reason: "x", from: "active" });
    await t.services.accountState.suspend({ doctorId: doctor.doctorId, supportUserId: supportId, reason: "x", from: "read_only" });
    expect((await rows("SELECT status FROM appointment"))[0]?.status).toBe("booked");
  });
});

describe("aviso de solo lectura en las páginas", () => {
  it("la agenda en HTML avisa que la cuenta está en solo lectura, y con la cuenta activa no", async () => {
    const doctor = await clinic("read_only");
    const staff = await agendaClientFor(t, pool, "doctor", { doctor });
    const page = () => t.app.inject({ method: "GET", url: "/agenda/dia/2026-06-16", remoteAddress: uniqueIp(), headers: { cookie: staff.client.cookie, accept: "text/html" } });
    expect((await page()).body).toContain("Tu cuenta está en solo lectura");
    await setAccountState(pool, doctor.doctorId, "active");
    expect((await page()).body).not.toContain("Tu cuenta está en solo lectura");
  });
});

describe("el móvil de emergencias respeta el estado de la cuenta", () => {
  it("en solo lectura o suspendida no se puede cambiar; activa sí", async () => {
    const doctor = await clinic("read_only");
    const owner = await sessionFor(t.services, doctor.user);
    const change = (mobile: string) =>
      postForm(t.app, "/cuenta/movil-emergencia", { _csrf: owner.csrf, currentPassword: doctor.user.password, emergencyMobile: mobile }, owner.cookie);
    const mobileOf = async () => (await rows("SELECT emergency_mobile FROM doctor WHERE id = ?", [doctor.doctorId]))[0]?.emergency_mobile;
    const original = await mobileOf();

    expect((await change("5511112222")).statusCode).toBe(403);
    expect(await mobileOf()).toBe(original);

    await setAccountState(pool, doctor.doctorId, "active");
    expect((await change("5511112222")).statusCode).toBe(200);
    expect(await mobileOf()).toBe("5511112222");
  });
});
