import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createAppointment, createDoctor, createPatient, createPublishedSite, createTestPool, createUser, ensurePrivacyDocument, resetDatabase, setAccountState } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let support: AuthedClient;
let supportId: number;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
  const user = await createSupportWithMfa(t, pool);
  supportId = user.id;
  support = await sessionFor(t.services, user);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const stateOf = async (doctorId: number) => (await rows("SELECT account_state FROM doctor WHERE id = ?", [doctorId]))[0]?.account_state as string;
const actions = ["suspender", "solo-lectura", "reactivar"] as const;

describe("POST de cambio de estado: validación", () => {
  it("sin motivo o sin confirmar responde 400 y no cambia nada", async () => {
    const doctor = await createDoctor(pool);
    const base = { _csrf: support.csrf, from: "active" };
    for (const fields of [{ ...base, confirm: "yes" }, { ...base, reason: "   ", confirm: "yes" }, { ...base, reason: "motivo" }, { ...base, reason: "motivo", confirm: "no" }]) {
      const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/suspender`, fields, support.cookie);
      expect(response.statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect(await stateOf(doctor.doctorId)).toBe("active");
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
  });

  it("un `from` fuera del enum y un motivo de más de 500 caracteres son 400", async () => {
    const doctor = await createDoctor(pool);
    const common = { _csrf: support.csrf, confirm: "yes" };
    expect((await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/suspender`, { ...common, reason: "x", from: "otro" }, support.cookie)).statusCode).toBe(400);
    expect((await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/suspender`, { ...common, reason: "x".repeat(501), from: "active" }, support.cookie)).statusCode).toBe(400);
    expect(await stateOf(doctor.doctorId)).toBe("active");
  });

  it("sin token CSRF responde 403 y no cambia nada", async () => {
    const doctor = await createDoctor(pool);
    const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/suspender`, { reason: "x", confirm: "yes", from: "active" }, support.cookie);
    expect(response.statusCode).toBe(403);
    expect(await stateOf(doctor.doctorId)).toBe("active");
  });

  it("un id inválido es 400 y un médico inexistente es 404", async () => {
    const fields = { _csrf: support.csrf, reason: "x", confirm: "yes", from: "active" };
    expect((await postForm(t.app, "/soporte/medicos/abc/suspender", fields, support.cookie)).statusCode).toBe(400);
    expect((await postForm(t.app, "/soporte/medicos/999999/suspender", fields, support.cookie)).statusCode).toBe(404);
  });

  it("el id de una cuenta de soporte, incluida la propia, responde 404 y no cambia nada (FR-013)", async () => {
    const other = await createUser(pool, { role: "support" });
    for (const id of [supportId, other.id]) {
      for (const action of actions) {
        const response = await postForm(t.app, `/soporte/medicos/${id}/${action}`, { _csrf: support.csrf, reason: "x", confirm: "yes", from: "active" }, support.cookie);
        expect(response.statusCode, `${action} ${id}`).toBe(404);
      }
    }
    expect((await rows("SELECT status FROM `user` WHERE id IN (?, ?)", [supportId, other.id])).every((row) => row.status === "active")).toBe(true);
    expect(await rows("SELECT id FROM support_action_log")).toEqual([]);
  });
});

describe("POST de cambio de estado: resultados", () => {
  it("suspender, poner en solo lectura y reactivar redirigen al detalle (303) y cambian el estado", async () => {
    const doctor = await createDoctor(pool);
    const send = (action: (typeof actions)[number], from: string) =>
      postForm(t.app, `/soporte/medicos/${doctor.doctorId}/${action}`, { _csrf: support.csrf, reason: "motivo", confirm: "yes", from }, support.cookie);
    for (const [action, from, expected] of [["solo-lectura", "active", "read_only"], ["suspender", "read_only", "suspended"], ["reactivar", "suspended", "active"]] as const) {
      const response = await send(action, from);
      expect(response.statusCode, action).toBe(303);
      expect(response.headers.location).toBe(`/soporte/medicos/${doctor.doctorId}`);
      expect(await stateOf(doctor.doctorId)).toBe(expected);
    }
  });

  it("un estado desactualizado o una transición inválida responde 409", async () => {
    const doctor = await createDoctor(pool);
    await setAccountState(pool, doctor.doctorId, "read_only");
    const stale = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/suspender`, { _csrf: support.csrf, reason: "x", confirm: "yes", from: "active" }, support.cookie);
    expect(stale.statusCode).toBe(409);
    const invalid = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/solo-lectura`, { _csrf: support.csrf, reason: "x", confirm: "yes", from: "read_only" }, support.cookie);
    expect(invalid.statusCode).toBe(409);
    expect(await stateOf(doctor.doctorId)).toBe("read_only");
  });

  it("sobre un médico pendiente o rechazado responde 409", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const doctor = await createDoctor(pool, { status });
      const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/suspender`, { _csrf: support.csrf, reason: "x", confirm: "yes", from: "active" }, support.cookie);
      expect(response.statusCode, status).toBe(409);
    }
  });
});

describe("acceso al panel", () => {
  it("médico, recepción y paciente reciben 403 y sin sesión 401, en lista, detalle y acciones", async () => {
    const doctor = await createDoctor(pool);
    const urls = ["/soporte/medicos", `/soporte/medicos/${doctor.doctorId}`];
    for (const url of urls) expect((await t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "application/json" } })).statusCode).toBe(401);
    for (const role of ["doctor", "reception", "patient"] as const) {
      const client = await sessionFor(t.services, await createUser(pool, { role }));
      for (const url of urls) expect((await t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept: "application/json" } })).statusCode, `${role} ${url}`).toBe(403);
      for (const action of actions) {
        const response = await postForm(t.app, `/soporte/medicos/${doctor.doctorId}/${action}`, { _csrf: client.csrf, reason: "x", confirm: "yes", from: "active" }, client.cookie);
        expect(response.statusCode, `${role} ${action}`).toBe(403);
      }
    }
    expect(await stateOf(doctor.doctorId)).toBe("active");
  });

  it("soporte sin el doble factor activo es redirigido al alta del doble factor", async () => {
    const user = await createUser(pool, { role: "support" });
    const client = await sessionFor(t.services, user);
    const doctor = await createDoctor(pool);
    const response = await t.app.inject({ method: "GET", url: `/soporte/medicos/${doctor.doctorId}`, remoteAddress: uniqueIp(), headers: { cookie: client.cookie } });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/cuenta/mfa/alta");
  });
});

describe("detalle con estado operativo", () => {
  it("muestra el estado, quién y cuándo, el micrositio y solo el número de citas futuras", async () => {
    const doctor = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const patient = await createPatient(pool, { fullName: "Paciente Reconocible Única" });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date(Date.now() + 3 * 86_400_000) });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date(Date.now() + 5 * 86_400_000) });
    await t.services.accountState.setReadOnly({ doctorId: doctor.doctorId, supportUserId: supportId, reason: "x", from: "active" });

    const response = await t.app.inject({ method: "GET", url: `/soporte/medicos/${doctor.doctorId}`, remoteAddress: uniqueIp(), headers: { cookie: support.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Solo lectura");
    expect(response.body).toContain("clinica-rios");
    expect(response.body).toMatch(/Citas futuras<\/dt><dd>2</);
    expect(response.body).not.toContain("Paciente Reconocible Única");
    expect(response.body).toContain("No escribas datos de pacientes");

    const json = await t.app.inject({ method: "GET", url: `/soporte/medicos/${doctor.doctorId}`, remoteAddress: uniqueIp(), headers: { cookie: support.cookie, accept: "application/json" } });
    expect(JSON.stringify(json.json())).not.toContain("Paciente Reconocible Única");
  });

  it("la lista filtra por estado operativo y busca por nombre o correo con comodines escapados", async () => {
    const suspended = await createDoctor(pool, { fullName: "Dr. Suspendido Prueba", email: "suspendido@example.com" });
    const active = await createDoctor(pool, { fullName: "Dr. Activo 100%" });
    await setAccountState(pool, suspended.doctorId, "suspended");
    const list = (query: string) => t.app.inject({ method: "GET", url: `/soporte/medicos?${query}`, remoteAddress: uniqueIp(), headers: { cookie: support.cookie } });
    expect((await list("estado=suspended")).body).toContain("Dr. Suspendido Prueba");
    expect((await list("estado=suspended")).body).not.toContain("Dr. Activo 100%");
    expect((await list("estado=all&q=suspendido@example")).body).toContain("Dr. Suspendido Prueba");
    expect((await list("estado=all&q=%25")).body).not.toContain("Dr. Suspendido Prueba");
    expect((await list("estado=all&q=100%25")).body).toContain("Dr. Activo 100%");
    expect((await list("estado=otro")).statusCode).toBe(400);
    expect(active.doctorId).toBeGreaterThan(0);
  });
});
