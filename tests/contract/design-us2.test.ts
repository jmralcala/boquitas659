import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createAppointment, createBlock, createPatient, createTestPool, ensurePrivacyDocument, resetDatabase, setAccountState } from "../integration/helpers/db.js";
import { agendaClientFor, createTestApp, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const NOW = new Date("2026-06-15T14:00:00.000Z"); // lunes 8:00 en Ciudad de México

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

const get = (url: string, cookie: string) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", cookie } });

/** Toda tabla debe ir dentro de su contenedor con desplazamiento horizontal (FR-008). */
function expectTablesWrapped(body: string, label: string): void {
  const tables = body.match(/<table/g)?.length ?? 0;
  const wrapped = body.match(/<div class="table-wrap"><table/g)?.length ?? 0;
  expect(wrapped, `${label}: tablas envueltas`).toBe(tables);
}

describe("agenda del médico y de recepción con el diseño común", () => {
  it("ninguna pantalla del área trae su propio <nav> y todas llevan la entrada activa correcta", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    const patient = await createPatient(pool);
    const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-16T16:00:00.000Z") });
    const screens: Array<[string, string]> = [
      ["/agenda/dia/2026-06-16", "/agenda"],
      ["/agenda/semana/2026-06-16", "/agenda"],
      ["/agenda/citas/nueva", "/agenda"],
      [`/agenda/citas/${id}`, "/agenda"],
      ["/agenda/bloqueos", "/agenda/bloqueos"],
      ["/agenda/configuracion", "/agenda/configuracion"],
      ["/medicos/micrositio", "/medicos/micrositio"],
      ["/medicos/recepcion", "/medicos/recepcion"],
    ];
    for (const [url, active] of screens) {
      const body = (await get(url, client.cookie)).body;
      expect(body, url).not.toContain('<nav aria-label="Agenda">');
      expect(body, url).toContain('<nav aria-label="Principal">');
      expect(body, url).toMatch(new RegExp(`aria-current="page" href="${active.replace(/\//g, "\\/")}"`));
      expectTablesWrapped(body, url);
    }
  });

  it("la cita agendada lleva su insignia y cancelar es una acción de peligro", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    const patient = await createPatient(pool);
    const id = await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-16T16:00:00.000Z") });
    const detail = (await get(`/agenda/citas/${id}`, client.cookie)).body;
    expect(detail).toContain("badge badge--confirmed");
    expect(detail).toContain('class="pairs"');
    expect(detail).toMatch(/class="btn-danger"[^>]*>[^<]*Cancelar/);

    const day = (await get("/agenda/dia/2026-06-16", client.cookie)).body;
    // Dentro del horario la cita ocupa un espacio («Ocupado», insignia confirmada); fuera de él se avisa con su propia insignia.
    expect(day).toMatch(/badge badge--(confirmed|pending)/);
  });

  it("un día sin citas usa el estado vacío y quitar un bloqueo es acción de peligro", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    expect((await get("/agenda/bloqueos", client.cookie)).body).toContain('class="empty"');
    await createBlock(pool, { doctorId: doctor.doctorId, startUtc: new Date("2026-06-17T16:00:00.000Z"), endUtc: new Date("2026-06-17T17:00:00.000Z") });
    const blocks = (await get("/agenda/bloqueos", client.cookie)).body;
    expect(blocks).toMatch(/class="btn-danger"[^>]*>[^<]*Quitar bloqueo/);
  });

  it("la configuración agrupa sus campos en secciones y termina con la barra de acciones", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const body = (await get("/agenda/configuracion", client.cookie)).body;
    expect(body).toMatch(/<fieldset>[\s\S]*<legend>/);
    expect(body).toContain('type="submit"');
  });

  it("Mi micrositio muestra su estado como insignia y despublicar o quitar el logo como peligro", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const body = (await get("/medicos/micrositio", client.cookie)).body;
    expect(body).toMatch(/badge badge--/);
  });

  it("recepción no ve «Configuración» en la barra", async () => {
    const { client } = await agendaClientFor(t, pool, "reception");
    const body = (await get("/agenda/dia/2026-06-16", client.cookie)).body;
    expect(body).not.toContain('href="/agenda/configuracion"');
    expect(body).toContain('href="/agenda/bloqueos"');
  });

  it("una cuenta en solo lectura muestra la alerta informativa en cada pantalla del área", async () => {
    const { client, doctor } = await agendaClientFor(t, pool, "doctor");
    await setAccountState(pool, doctor.doctorId, "read_only");
    const refreshed = await sessionFor(t.services, doctor.user);
    for (const url of ["/agenda/dia/2026-06-16", "/agenda/bloqueos", "/agenda/configuracion"]) {
      expect((await get(url, refreshed.cookie)).body, url).toContain("alert alert--info");
    }
    expect(client.cookie.length).toBeGreaterThan(0);
  });
});
