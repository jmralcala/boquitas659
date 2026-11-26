import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createPatient, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, postForm, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string, cookie?: string, accept = "text/html") =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept, ...(cookie ? { cookie } : {}) } });

describe("botón «Salir»", () => {
  it("aparece arriba de las páginas HTML de quien tiene sesión, con el token CSRF de su sesión", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const body = (await get("/derechos", client.cookie)).body;
    expect(body).toContain('<form method="post" action="/logout">');
    expect(body).toContain(`name="_csrf" value="${client.csrf}"`);
    expect(body).toContain(">Salir</button>");
    expect(body.indexOf("Salir")).toBeLessThan(body.indexOf("<main>"));
  });

  it("también lo ven el personal de soporte y el médico", async () => {
    const support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
    expect((await get("/soporte", support.cookie)).body).toContain('action="/logout"');
    const doctor = await sessionFor(t.services, await createUser(pool, { role: "doctor" }));
    expect((await get("/derechos", doctor.cookie)).body).toContain('action="/logout"');
  });

  it("sin sesión no aparece, y las respuestas JSON no cambian", async () => {
    expect((await get("/derechos")).body).not.toContain("/logout");
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const json = await get("/soporte/metricas", client.cookie, "application/json");
    expect(json.body).not.toContain("/logout");
  });

  it("al pulsarlo con ese token la sesión se cierra y la cookie se limpia", async () => {
    const patient = await createPatient(pool);
    const client = await sessionFor(t.services, patient.user);
    const logout = await postForm(t.app, "/logout", { _csrf: client.csrf }, client.cookie, uniqueIp());
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe("/login");
    // Con la cookie vieja ya no hay sesión: la página no vuelve a mostrar el botón.
    expect((await get("/derechos", client.cookie)).body).not.toContain("/logout");
  });
});
