import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createCalendarHours, createCalendarSettings, createDoctor, createPatient, createTestPool, resetDatabase, WEEKDAY_HOURS } from "../integration/helpers/db.js";
import {
  JPEG,
  PNG,
  agendaClientFor,
  createSupportWithMfa,
  createTestApp,
  postMultipart,
  sessionFor,
  uniqueIp,
  type AgendaClient,
  type AuthedClient,
  type TestApp,
} from "../integration/helpers/app.js";

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

function get(client: AuthedClient, accept = "application/json") {
  return t.app.inject({ method: "GET", url: "/medicos/micrositio", remoteAddress: uniqueIp(), headers: { cookie: client.cookie, accept } });
}

function post(client: AuthedClient, url: string, fields: Record<string, string> = {}, options: { csrf?: boolean } = {}) {
  return t.app.inject({
    method: "POST",
    url,
    remoteAddress: uniqueIp(),
    headers: { cookie: client.cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...(options.csrf === false ? {} : { _csrf: client.csrf }), ...fields }).toString(),
  });
}

function uploadLogo(client: AuthedClient, content: Buffer, filename = "logo.png") {
  return postMultipart(t.app, "/medicos/micrositio/logo", { _csrf: client.csrf }, [{ field: "logo", filename, content, contentType: "image/png" }], client.cookie);
}

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

/** Médico listo para publicar salvo nombre y dirección: teléfono del consultorio y horario ya configurados. */
async function doctorReady(): Promise<AgendaClient> {
  const agenda = await agendaClientFor(t, pool, "doctor");
  await pool.execute("UPDATE doctor SET office_phone = '5598765432' WHERE id = ?", [agenda.doctor.doctorId]);
  await createCalendarSettings(pool, agenda.doctor.doctorId);
  await createCalendarHours(pool, agenda.doctor.doctorId, WEEKDAY_HOURS);
  return agenda;
}

interface StatusJson {
  site: { slug: string; address: string | null; status: string; hasLogo: boolean; url: string } | null;
  missing: string[];
}

describe("GET /medicos/micrositio", () => {
  it("a un médico nuevo le muestra que no hay nombre y todo lo que falta", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await get(client);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      site: null,
      missing: ["nombre del enlace", "dirección", "teléfono del consultorio", "horario de atención (al menos una franja)"],
    });
  });

  it("en HTML muestra los formularios con CSRF; tras elegir el nombre, el enlace y los pasos que faltan", async () => {
    const { client } = await doctorReady();
    const before = await get(client, "text/html");
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('action="/medicos/micrositio/nombre"');
    expect(before.body).toContain('name="_csrf"');

    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    const after = await get(client, "text/html");
    expect(after.body).toContain("/c/clinica-sonrisa");
    expect(after.body).toContain('action="/medicos/micrositio"');
    expect(after.body).toContain('enctype="multipart/form-data"');
    expect(after.body).not.toContain('action="/medicos/micrositio/nombre"'); // el nombre ya no se puede cambiar
  });

  it("en HTML escapa la dirección guardada", async () => {
    const { client } = await doctorReady();
    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    await post(client, "/medicos/micrositio", { address: '<script>alert("x")</script>' });
    const page = await get(client, "text/html");
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).toContain("&lt;script&gt;");
  });
});

describe("el nombre del enlace", () => {
  it("se elige una vez: 303, queda en borrador y la segunda vez es 409 slug_locked", async () => {
    const { client } = await doctorReady();
    const first = await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe("/medicos/micrositio");
    const status = (await get(client)).json() as StatusJson;
    expect(status.site).toMatchObject({ slug: "clinica-sonrisa", status: "draft", hasLogo: false });
    expect(status.site?.url).toMatch(/\/c\/clinica-sonrisa$/);

    const second = await post(client, "/medicos/micrositio/nombre", { slug: "otro-nombre" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "slug_locked" });
  });

  it.each(["ab", "Clinica", "mi clinica", "-abc", "a--b", "clínica", "x".repeat(41), ""])("rechaza %j con 400 y el mensaje en el campo slug", async (slug) => {
    const { client } = await doctorReady();
    const response = await post(client, "/medicos/micrositio/nombre", { slug });
    expect(response.statusCode).toBe(400);
    expect(Object.keys((response.json() as { fields: Record<string, string[]> }).fields)).toEqual(["slug"]);
    expect(await rows("SELECT * FROM doctor_site")).toEqual([]);
  });

  it("un nombre en uso por otro médico responde 409 slug_taken", async () => {
    const a = await doctorReady();
    const b = await doctorReady();
    await post(a.client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    const response = await post(b.client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "slug_taken" });
  });

  it("dos médicos que lo piden a la vez: uno 303 y otro 409", async () => {
    const a = await doctorReady();
    const b = await doctorReady();
    const results = await Promise.all([
      post(a.client, "/medicos/micrositio/nombre", { slug: "carrera-ok" }),
      post(b.client, "/medicos/micrositio/nombre", { slug: "carrera-ok" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([303, 409]);
  });
});

describe("dirección y logo", () => {
  it("la dirección se guarda (303) y se valida (400)", async () => {
    const { client } = await doctorReady();
    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    expect((await post(client, "/medicos/micrositio", { address: "Calle Falsa 123" })).statusCode).toBe(303);
    expect(((await get(client)).json() as StatusJson).site?.address).toBe("Calle Falsa 123");
    for (const address of ["", "x".repeat(301)]) {
      const bad = await post(client, "/medicos/micrositio", { address });
      expect(bad.statusCode).toBe(400);
      expect(Object.keys((bad.json() as { fields: Record<string, string[]> }).fields)).toEqual(["address"]);
    }
    expect(((await get(client)).json() as StatusJson).site?.address).toBe("Calle Falsa 123");
  });

  it("sin nombre elegido no se puede guardar la dirección ni el logo (409)", async () => {
    const { client } = await doctorReady();
    expect((await post(client, "/medicos/micrositio", { address: "Calle 1" })).statusCode).toBe(409);
    expect((await uploadLogo(client, PNG)).statusCode).toBe(409);
  });

  it("sube un logo PNG o JPEG (303), lo reemplaza y lo quita", async () => {
    const { client } = await doctorReady();
    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    expect((await uploadLogo(client, PNG)).statusCode).toBe(303);
    expect(((await get(client)).json() as StatusJson).site?.hasLogo).toBe(true);
    const logos = join(t.services.env.LOGO_STORAGE_DIR);
    expect(readdirSync(logos)).toHaveLength(1);
    expect((await uploadLogo(client, JPEG, "otro.jpg")).statusCode).toBe(303);
    expect(readdirSync(logos)).toHaveLength(1);
    expect((await post(client, "/medicos/micrositio/logo/quitar")).statusCode).toBe(303);
    expect(((await get(client)).json() as StatusJson).site?.hasLogo).toBe(false);
    expect(readdirSync(logos)).toEqual([]);
  });

  it("un archivo que no es una imagen válida responde 400 y no guarda nada", async () => {
    const { client } = await doctorReady();
    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    expect((await uploadLogo(client, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "logo.svg")).statusCode).toBe(400);
    expect((await uploadLogo(client, Buffer.from("texto que se llama png"), "falso.png")).statusCode).toBe(400);
    expect((await uploadLogo(client, Buffer.concat([PNG, Buffer.alloc(1_048_576)]))).statusCode).toBe(400);
    expect((await uploadLogo(client, Buffer.alloc(0))).statusCode).toBe(400);
    expect(((await get(client)).json() as StatusJson).site?.hasLogo).toBe(false);
  });
});

describe("publicar y despublicar", () => {
  it("sin todo lo necesario responde 409 con la lista de lo que falta y no publica", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const response = await post(client, "/medicos/micrositio/publicar");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "site_incomplete",
      fields: { missing: ["nombre del enlace", "dirección", "teléfono del consultorio", "horario de atención (al menos una franja)"] },
    });
  });

  it("con todo listo publica (303) y despublica (303); despublicar de nuevo es 409", async () => {
    const { client } = await doctorReady();
    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    await post(client, "/medicos/micrositio", { address: "Calle Falsa 123" });
    expect((await post(client, "/medicos/micrositio/publicar")).statusCode).toBe(303);
    expect(((await get(client)).json() as StatusJson).site?.status).toBe("published");
    expect((await post(client, "/medicos/micrositio/despublicar")).statusCode).toBe(303);
    expect(((await get(client)).json() as StatusJson).site?.status).toBe("unpublished");
    expect((await post(client, "/medicos/micrositio/despublicar")).statusCode).toBe(409);
  });
});

describe("acceso y seguridad", () => {
  const POSTS: [string, Record<string, string>][] = [
    ["/medicos/micrositio/nombre", { slug: "nuevo-nombre" }],
    ["/medicos/micrositio", { address: "Calle 1" }],
    ["/medicos/micrositio/logo/quitar", {}],
    ["/medicos/micrositio/publicar", {}],
    ["/medicos/micrositio/despublicar", {}],
  ];

  it("la recepción recibe 403 en todo y no cambia nada", async () => {
    const reception = await agendaClientFor(t, pool, "reception");
    expect((await get(reception.client)).statusCode).toBe(403);
    for (const [url, fields] of POSTS) expect((await post(reception.client, url, fields)).statusCode, url).toBe(403);
    expect((await uploadLogo(reception.client, PNG)).statusCode).toBe(403);
    expect(await rows("SELECT * FROM doctor_site")).toEqual([]);
  });

  it("un paciente, soporte y un médico pendiente o rechazado reciben 403; sin sesión, 401", async () => {
    const patient = await createPatient(pool);
    const support = await createSupportWithMfa(t, pool);
    const pending = await createDoctor(pool, { status: "pending" });
    const rejected = await createDoctor(pool, { status: "rejected" });
    for (const user of [patient.user, support, pending.user, rejected.user]) {
      const client = await sessionFor(t.services, user);
      expect((await get(client)).statusCode).toBe(403);
      for (const [url, fields] of POSTS) expect((await post(client, url, fields)).statusCode, `${user.role} ${url}`).toBe(403);
    }
    const anonymous = await t.app.inject({ method: "GET", url: "/medicos/micrositio", remoteAddress: uniqueIp(), headers: { accept: "application/json" } });
    expect(anonymous.statusCode).toBe(401);
  });

  it("sin el token CSRF responde 403 en todas las rutas POST", async () => {
    const { client } = await doctorReady();
    for (const [url, fields] of POSTS) expect((await post(client, url, fields, { csrf: false })).statusCode, url).toBe(403);
    const noCsrf = await postMultipart(t.app, "/medicos/micrositio/logo", {}, [{ field: "logo", filename: "l.png", content: PNG, contentType: "image/png" }], client.cookie);
    expect(noCsrf.statusCode).toBe(403);
    expect(await rows("SELECT * FROM doctor_site")).toEqual([]);
  });

  it("el médico sale de la sesión: un doctorId en el cuerpo no cambia a quién se guarda", async () => {
    const a = await doctorReady();
    const b = await doctorReady();
    await post(a.client, "/medicos/micrositio/nombre", { slug: "consultorio-a", doctorId: String(b.doctor.doctorId) });
    expect(await rows("SELECT doctor_id, slug FROM doctor_site")).toEqual([{ doctor_id: a.doctor.doctorId, slug: "consultorio-a" }]);
  });

  it("aislamiento: cada médico ve y cambia solo lo suyo", async () => {
    const a = await doctorReady();
    const b = await doctorReady();
    await post(a.client, "/medicos/micrositio/nombre", { slug: "consultorio-a" });
    await post(a.client, "/medicos/micrositio", { address: "Dirección de A" });
    expect(((await get(b.client)).json() as StatusJson).site).toBeNull();
    await post(b.client, "/medicos/micrositio/nombre", { slug: "consultorio-b" });
    expect(((await get(a.client)).json() as StatusJson).site).toMatchObject({ slug: "consultorio-a", address: "Dirección de A" });
  });

  it("registra cada cambio en el registro de acciones con el médico y sin contenido", async () => {
    const { client, doctor } = await doctorReady();
    await post(client, "/medicos/micrositio/nombre", { slug: "clinica-sonrisa" });
    await post(client, "/medicos/micrositio", { address: "Calle Falsa 123" });
    const log = await rows("SELECT doctor_id, actor_user_id, action FROM calendar_action_log ORDER BY id");
    expect(log).toEqual([
      { doctor_id: doctor.doctorId, actor_user_id: doctor.user.id, action: "site_updated" },
      { doctor_id: doctor.doctorId, actor_user_id: doctor.user.id, action: "site_updated" },
    ]);
    expect(JSON.stringify(log)).not.toContain("Calle Falsa");
  });
});
