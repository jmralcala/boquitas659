import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { agendaClientFor, createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

function get(url: string, client?: AuthedClient) {
  return t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { ...(client ? { cookie: client.cookie } : {}), accept: "application/json" } });
}

describe("un nombre de enlace inexistente responde como cualquier ruta inexistente", () => {
  it("mismo estado y mismo cuerpo", async () => {
    const unknownSlug = await get("/c/no-existe-este-nombre");
    const unknownRoute = await get("/ruta-que-no-existe");
    expect(unknownSlug.statusCode).toBe(404);
    expect(unknownSlug.body).toBe(unknownRoute.body);
  });
});

describe("GET /medicos/micrositio: solo el médico aprobado", () => {
  it("sin sesión 401", async () => {
    expect((await get("/medicos/micrositio")).statusCode).toBe(401);
  });

  it("un paciente recibe 403", async () => {
    const patient = await createPatient(pool);
    expect((await get("/medicos/micrositio", await sessionFor(t.services, patient.user))).statusCode).toBe(403);
  });

  it("soporte (con doble factor) recibe 403", async () => {
    const support = await createSupportWithMfa(t, pool);
    expect((await get("/medicos/micrositio", await sessionFor(t.services, support))).statusCode).toBe(403);
  });

  it.each(["pending", "rejected"] as const)("un médico %s recibe 403", async (status) => {
    const doctor = await createDoctor(pool, { status });
    expect((await get("/medicos/micrositio", await sessionFor(t.services, doctor.user))).statusCode).toBe(403);
  });

  it("la recepción recibe 403: solo el médico administra su micrositio", async () => {
    const reception = await agendaClientFor(t, pool, "reception");
    expect((await get("/medicos/micrositio", reception.client)).statusCode).toBe(403);
  });

  it("el médico aprobado entra", async () => {
    const doctor = await agendaClientFor(t, pool, "doctor");
    expect((await get("/medicos/micrositio", doctor.client)).statusCode).toBe(200);
  });
});
