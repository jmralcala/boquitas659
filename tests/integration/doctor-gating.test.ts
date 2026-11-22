import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createTestPool, createUser, resetDatabase } from "./helpers/db.js";
import { createTestApp, sessionFor, type TestApp } from "./helpers/app.js";

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

async function get(url: string, cookie?: string) {
  return t.app.inject({
    method: "GET",
    url,
    headers: { ...(cookie ? { cookie } : {}), accept: "application/json" },
  });
}

describe("médicos pendientes o rechazados", () => {
  for (const status of ["pending", "rejected"] as const) {
    it(`un médico ${status} se autentica pero solo ve /medicos/estado`, async () => {
      const doctor = await createDoctor(pool, { status });
      const { cookie } = await sessionFor(t.services, doctor.user);

      const estado = await get("/medicos/estado", cookie);
      expect(estado.statusCode).toBe(200);
      expect(estado.json().status).toBe(status);

      // Cualquier ruta que exija médico aprobado responde 403.
      const panel = await get("/medicos/panel", cookie);
      expect(panel.statusCode).toBe(403);

      // El inicio lo manda a la pantalla de estado.
      const inicio = await t.app.inject({ method: "GET", url: "/medicos/inicio", headers: { cookie } });
      expect(inicio.statusCode).toBe(303);
      expect(inicio.headers.location).toBe("/medicos/estado");
    });
  }

  it("el estado rechazado muestra el motivo", async () => {
    const doctor = await createDoctor(pool, { status: "rejected" });
    const { cookie } = await sessionFor(t.services, doctor.user);
    const response = await t.app.inject({ method: "GET", url: "/medicos/estado", headers: { cookie } });
    expect(response.body).toContain("Motivo de prueba");
    expect(response.body).toContain("/medicos/estado/reenviar");
  });
});

describe("médico aprobado", () => {
  it("accede al panel y /medicos/inicio lo lleva ahí", async () => {
    const doctor = await createDoctor(pool, { status: "approved" });
    const { cookie } = await sessionFor(t.services, doctor.user);
    expect((await get("/medicos/panel", cookie)).statusCode).toBe(200);
    const inicio = await t.app.inject({ method: "GET", url: "/medicos/inicio", headers: { cookie } });
    expect(inicio.headers.location).toBe("/medicos/panel");
  });
});

describe("otros usuarios", () => {
  it("sin sesión responde 401", async () => {
    expect((await get("/medicos/estado")).statusCode).toBe(401);
    expect((await get("/medicos/panel")).statusCode).toBe(401);
  });

  it("un paciente o un usuario de recepción no entra a las rutas de médicos", async () => {
    for (const role of ["patient", "reception", "support"] as const) {
      const user = await createUser(pool, { role });
      const { cookie } = await sessionFor(t.services, user);
      expect((await get("/medicos/estado", cookie)).statusCode, role).toBe(403);
      expect((await get("/medicos/panel", cookie)).statusCode, role).toBe(403);
    }
  });

  it("un usuario con rol de médico pero sin ficha de médico no entra al panel", async () => {
    const user = await createUser(pool, { role: "doctor" });
    const { cookie } = await sessionFor(t.services, user);
    expect((await get("/medicos/panel", cookie)).statusCode).toBe(403);
  });
});
