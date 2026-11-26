import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createEmail, createTestPool, ensurePrivacyDocument, resetDatabase, setAccountState } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let support: AuthedClient;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
  support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string) => t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", cookie: support.cookie } });

function expectTablesWrapped(body: string, label: string): void {
  const tables = body.match(/<table/g)?.length ?? 0;
  const wrapped = body.match(/<div class="table-wrap"><table/g)?.length ?? 0;
  expect(wrapped, `${label}: tablas envueltas`).toBe(tables);
}

describe("panel de soporte con el diseño común", () => {
  it("ninguna pantalla trae su <nav> propio y todas llevan la barra de soporte con su entrada activa", async () => {
    const doctor = await createDoctor(pool, { status: "pending" });
    const screens: Array<[string, string]> = [
      ["/soporte", "/soporte"],
      ["/soporte/medicos", "/soporte/medicos"],
      [`/soporte/medicos/${doctor.doctorId}`, "/soporte/medicos"],
      [`/soporte/medicos/${doctor.doctorId}/liberar-cedula`, "/soporte/medicos"],
      ["/soporte/micrositios", "/soporte/micrositios"],
      ["/soporte/correos", "/soporte/correos"],
      ["/soporte/metricas", "/soporte/metricas"],
      ["/soporte/historial", "/soporte/historial"],
    ];
    for (const [url, active] of screens) {
      const body = (await get(url)).body;
      expect(body, url).not.toContain('<nav aria-label="Panel de soporte">');
      expect(body, url).toContain('<nav aria-label="Principal">');
      expect(body, url).toMatch(new RegExp(`aria-current="page" href="${active.replace(/\//g, "\\/")}"`));
      expectTablesWrapped(body, url);
    }
  });

  it("la lista de médicos muestra el estado de aprobación y de cuenta como insignias con texto", async () => {
    const approved = await createDoctor(pool, { fullName: "Dra. Aprobada" });
    const suspended = await createDoctor(pool, { fullName: "Dr. Suspendido" });
    await setAccountState(pool, suspended.doctorId, "suspended");
    await createDoctor(pool, { fullName: "Dr. Pendiente", status: "pending" });
    const body = (await get("/soporte/medicos?estado=all")).body;
    expect(body).toContain("badge badge--confirmed");
    expect(body).toContain("Aprobada");
    expect(body).toContain("Pendiente");
    expect(approved.doctorId).toBeGreaterThan(0);
    const detail = (await get(`/soporte/medicos/${suspended.doctorId}`)).body;
    expect(detail).toContain("Suspendida");
    expect(detail).toContain('class="pairs"');
  });

  it("los formularios de acción agrupan motivo, casilla y advertencia, con el botón de cambio de estado como peligro", async () => {
    const doctor = await createDoctor(pool);
    const body = (await get(`/soporte/medicos/${doctor.doctorId}`)).body;
    expect(body).toContain("alert alert--warning");
    expect(body).toContain("No escribas datos de pacientes");
    expect(body).toMatch(/class="btn-danger"[^>]*>[^<]*Suspender/);
  });

  it("las métricas muestran «Cumple», «No cumple» o «Sin datos» con insignia", async () => {
    const body = (await get("/soporte/metricas")).body;
    expect(body).toMatch(/badge badge--(confirmed|cancelled|neutral)/);
    expect(body).toContain("sin datos");
  });

  it("las listas vacías del panel usan el estado vacío y los correos llevan insignia de estado", async () => {
    expect((await get("/soporte/historial")).body).toContain('class="empty"');
    await createEmail(pool, { template: "appointment_created", status: "failed", attempts: 3, lastErrorCode: "smtp_unavailable", to: "persona@example.com" });
    const mail = (await get("/soporte/correos")).body;
    expect(mail).toContain("badge badge--cancelled");
    expect(mail).not.toContain("persona@example.com");
  });
});
