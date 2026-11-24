import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createEmail, createPublishedSite, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, postForm, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

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

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

const get = (url: string, client: AuthedClient = support, accept = "text/html") =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept } });
const ok = { reason: "motivo", confirm: "yes" };

describe("acceso", () => {
  it("médico, recepción y paciente reciben 403 y sin sesión 401 en todas las rutas de micrositios y correos", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const email = await createEmail(pool, { status: "failed" });
    const gets = ["/soporte", "/soporte/micrositios", `/soporte/micrositios/${doctor.doctorId}/enlace`, "/soporte/correos"];
    const posts = [`/soporte/micrositios/${doctor.doctorId}/enlace`, `/soporte/correos/${email}/reintentar`, `/soporte/correos/${email}/cancelar`];
    for (const url of gets) expect((await t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "application/json" } })).statusCode, url).toBe(401);
    for (const role of ["doctor", "reception", "patient"] as const) {
      const client = await sessionFor(t.services, await createUser(pool, { role }));
      for (const url of gets) expect((await get(url, client, "application/json")).statusCode, `${role} ${url}`).toBe(403);
      for (const url of posts) expect((await postForm(t.app, url, { _csrf: client.csrf, ...ok, slug: "nuevo-nombre" }, client.cookie)).statusCode, `${role} ${url}`).toBe(403);
    }
    expect((await rows("SELECT slug FROM doctor_site"))[0]?.slug).toBe("clinica-rios");
    expect((await rows("SELECT status FROM email_outbox"))[0]?.status).toBe("failed");
  });
});

describe("micrositios", () => {
  it("la lista acepta el filtro y rechaza uno inválido; el JSON trae conteos y filas", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    expect((await get("/soporte/micrositios?estado=published")).body).toContain("/c/clinica-rios");
    expect((await get("/soporte/micrositios?estado=otro")).statusCode).toBe(400);
    const json = (await get("/soporte/micrositios", support, "application/json")).json() as { counts: Record<string, number>; rows: unknown[] };
    expect(json.counts.published).toBe(1);
    expect(json.rows).toHaveLength(1);
  });

  it("el formulario de enlace muestra la advertencia y un médico inexistente es 404", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const form = await get(`/soporte/micrositios/${doctor.doctorId}/enlace`);
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain("dejará de funcionar");
    expect(form.body).toContain("90 días");
    expect((await get("/soporte/micrositios/999999/enlace")).statusCode).toBe(404);
    expect((await get("/soporte/micrositios/abc/enlace")).statusCode).toBe(400);
  });

  it("el POST cambia el enlace (303), y exige motivo, confirmación y un nombre válido", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const url = `/soporte/micrositios/${doctor.doctorId}/enlace`;
    const base = { _csrf: support.csrf, slug: "dra-rios", ...ok };
    for (const fields of [{ ...base, reason: "  " }, { ...base, confirm: "no" }, { ...base, slug: "Mal Nombre" }, { ...base, slug: "" }]) {
      expect((await postForm(t.app, url, fields, support.cookie)).statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect((await postForm(t.app, url, { ...base, _csrf: "" }, support.cookie)).statusCode).toBe(403);
    expect((await rows("SELECT slug FROM doctor_site"))[0]?.slug).toBe("clinica-rios");

    const response = await postForm(t.app, url, base, support.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/soporte/micrositios");
    expect((await rows("SELECT slug FROM doctor_site"))[0]?.slug).toBe("dra-rios");
  });

  it("un nombre en uso responde 409 con el formulario y los mensajes", async () => {
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const other = await createDoctor(pool);
    await createPublishedSite(pool, other, { slug: "ocupado" });
    const response = await postForm(t.app, `/soporte/micrositios/${doctor.doctorId}/enlace`, { _csrf: support.csrf, slug: "ocupado", ...ok }, support.cookie);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("Ese nombre ya está en uso");
  });
});

describe("correos", () => {
  it("la lista pagina y valida la página; el POST de reintentar y cancelar valida id, motivo y confirmación", async () => {
    const failed = await createEmail(pool, { status: "failed", attempts: 6, lastErrorCode: "smtp_timeout" });
    expect((await get("/soporte/correos")).statusCode).toBe(200);
    expect((await get("/soporte/correos?pagina=0")).statusCode).toBe(400);
    expect((await get("/soporte/correos?pagina=abc")).statusCode).toBe(400);

    expect((await postForm(t.app, `/soporte/correos/${failed}/reintentar`, { _csrf: support.csrf, reason: "", confirm: "yes" }, support.cookie)).statusCode).toBe(400);
    expect((await postForm(t.app, `/soporte/correos/${failed}/reintentar`, { _csrf: support.csrf, reason: "x" }, support.cookie)).statusCode).toBe(400);
    expect((await postForm(t.app, "/soporte/correos/abc/reintentar", { _csrf: support.csrf, ...ok }, support.cookie)).statusCode).toBe(400);
    expect((await postForm(t.app, "/soporte/correos/999999/reintentar", { _csrf: support.csrf, ...ok }, support.cookie)).statusCode).toBe(404);
    expect((await rows("SELECT status FROM email_outbox WHERE id = ?", [failed]))[0]?.status).toBe("failed");

    const retried = await postForm(t.app, `/soporte/correos/${failed}/reintentar`, { _csrf: support.csrf, ...ok }, support.cookie);
    expect(retried.statusCode).toBe(303);
    expect((await rows("SELECT status FROM email_outbox WHERE id = ?", [failed]))[0]?.status).toBe("queued");
    const again = await postForm(t.app, `/soporte/correos/${failed}/reintentar`, { _csrf: support.csrf, ...ok }, support.cookie);
    expect(again.statusCode).toBe(409);

    const cancelled = await postForm(t.app, `/soporte/correos/${failed}/cancelar`, { _csrf: support.csrf, ...ok }, support.cookie);
    expect(cancelled.statusCode).toBe(303);
    expect((await rows("SELECT status FROM email_outbox WHERE id = ?", [failed]))[0]?.status).toBe("cancelled");
  });

  it("el JSON trae conteos y fallidos sin payload ni correo completo", async () => {
    await createEmail(pool, { status: "failed", to: "persona.privada@example.com", lastErrorCode: "other", payload: { appointmentId: 5 } });
    const text = (await get("/soporte/correos", support, "application/json")).body;
    expect(text).toContain("p***@example.com");
    expect(text).not.toContain("persona.privada");
    expect(text).not.toContain("payload");
    expect(text).not.toContain("appointmentId");
    expect((await get("/soporte", support, "application/json")).json()).toMatchObject({ failedMail: 1 });
  });
});
