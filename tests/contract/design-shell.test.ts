import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/http/session-plugin.js";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, ensurePrivacyDocument, resetDatabase, setAccountState } from "../integration/helpers/db.js";
import { agendaClientFor, createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const getRoutes: string[] = [];

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, {}, {
    onRoute: (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method === "GET") getRoutes.push(route.url);
      }
    },
  });
});

beforeEach(async () => {
  await clearTables(pool);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string, cookie?: string) =>
  t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });

/** Rutas GET que no son pantallas HTML: archivos, imágenes y recursos del diseño. */
const NOT_SCREENS = new Set(["/assets/styles.css", "/assets/fonts/inter-var-latin.woff2", "/assets/fonts/manrope-var-latin.woff2", "/c/:slug/logo", "/soporte/medicos/:id/cedula"]);

const SAMPLE: Record<string, string> = {
  ":token": "a".repeat(43),
  ":slug": "clinica-demo",
  ":fecha": "2026-06-16",
  ":type": "patient_privacy",
  ":version": "1",
};
const concrete = (url: string): string => url.replace(/:[A-Za-z]+/g, (name) => SAMPLE[name] ?? "1");

/** Cada respuesta HTML (también las de error) debe heredar el diseño común (FR-001, FR-019). */
function expectDesigned(body: string, label: string): void {
  expect(body.match(/<link rel="stylesheet" href="\/assets\/styles\.css\?v=[a-z0-9]+">/g)?.length, `${label}: hoja`).toBe(1);
  expect(body, `${label}: lang`).toContain('<html lang="es">');
  expect(body, `${label}: viewport`).toContain('name="viewport"');
  expect(body, `${label}: noindex`).toContain('name="robots" content="noindex"');
  expect(body, `${label}: salto`).toMatch(/<a class="skip-link" href="#contenido">/);
  expect(body, `${label}: main`).toContain('<main id="contenido">');
  expect(body, `${label}: pie legal`).toContain('href="/legal"');
  expect(body, `${label}: style=`).not.toMatch(/\sstyle\s*=/);
  expect(body, `${label}: marcas sin resolver`).not.toContain("<!--shell:");
}

function navLinks(body: string): string[] {
  const nav = /<nav aria-label="Principal">([\s\S]*?)<\/nav>/.exec(body)?.[1] ?? "";
  return [...nav.matchAll(/<a [^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)].map((match) => match[1] as string);
}

function activeLinks(body: string): string[] {
  const nav = /<nav aria-label="Principal">([\s\S]*?)<\/nav>/.exec(body)?.[1] ?? "";
  return [...nav.matchAll(/<a [^>]*aria-current="page"[^>]*href="([^"]+)"|<a [^>]*href="([^"]+)"[^>]*aria-current="page"/g)].map((match) => (match[1] ?? match[2]) as string);
}

describe("toda pantalla HTML hereda el diseño (SC-001)", () => {
  it("recorre todas las rutas GET registradas, sin sesión y con cada rol, y exige el diseño en cada respuesta HTML", async () => {
    const patient = await sessionFor(t.services, (await createPatient(pool)).user);
    const doctor = await sessionFor(t.services, (await createDoctor(pool)).user);
    const reception = await sessionFor(t.services, await createUser(pool, { role: "reception" }));
    const support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
    const sessions: Array<[string, string | undefined]> = [["anónimo", undefined], ["paciente", patient.cookie], ["médico", doctor.cookie], ["recepción", reception.cookie], ["soporte", support.cookie]];

    const screens = [...new Set(getRoutes)].filter((url) => !NOT_SCREENS.has(url));
    expect(screens.length).toBeGreaterThan(40);
    let checked = 0;
    for (const url of screens) {
      for (const [who, cookie] of sessions) {
        const response = await get(concrete(url), cookie);
        if (!String(response.headers["content-type"] ?? "").startsWith("text/html")) continue;
        if (response.statusCode >= 300 && response.statusCode < 400) continue;
        expectDesigned(response.body, `${who} ${url} (${response.statusCode})`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 300_000);

  it("las páginas de error 404 y 403 usan el diseño común y no revelan detalles", async () => {
    const notFound = await get("/ruta-que-no-existe");
    expect(notFound.statusCode).toBe(404);
    expectDesigned(notFound.body, "404");
    const forbidden = await t.app.inject({ method: "POST", url: "/logout", remoteAddress: uniqueIp(), headers: { accept: "text/html" } });
    expect(forbidden.statusCode).toBe(403);
    expectDesigned(forbidden.body, "403");
  });
});

describe("estructura sin sesión", () => {
  it("las pantallas públicas usan la tarjeta centrada, sin barra lateral, tarjeta de usuario ni «Salir»", async () => {
    for (const url of ["/login", "/legal", "/derechos", "/recuperar"]) {
      const body = (await get(url)).body;
      expect(body, url).toMatch(/<body class="card-page( card-page--narrow)?">/);
      expect(body, url).not.toContain("sidebar");
      expect(body, url).not.toContain("user-card");
      expect(body, url).not.toContain('action="/logout"');
    }
  });
});

describe("estructura con sesión completa", () => {
  it("el paciente ve la barra con su navegación, la tarjeta de usuario y «Salir» con el token de su sesión", async () => {
    const client = await sessionFor(t.services, (await createPatient(pool)).user);
    const body = (await get("/pacientes/citas", client.cookie)).body;
    expect(body).toContain('class="has-shell"');
    expect(body).toContain('<aside class="sidebar">');
    expect(navLinks(body)).toEqual(["/pacientes/panel", "/pacientes/citas", "/pacientes/consultorios"]);
    expect(activeLinks(body)).toEqual(["/pacientes/citas"]);
    expect(body).toContain("Paciente");
    expect(body).toContain('<form method="post" action="/logout">');
    expect(body).toContain(`name="_csrf" value="${client.csrf}"`);
    expect(body).toContain("Agenda Dental");
  });

  it("el médico ve agenda, bloqueos, configuración, micrositio y recepción, con su entrada activa", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    const body = (await get("/agenda/bloqueos", client.cookie)).body;
    expect(navLinks(body)).toEqual(["/medicos/inicio", "/agenda", "/agenda/bloqueos", "/agenda/configuracion", "/medicos/micrositio", "/medicos/recepcion"]);
    expect(activeLinks(body)).toEqual(["/agenda/bloqueos"]);
    expect(body).toContain("Médico");
    expect(body).not.toContain('<nav aria-label="Agenda">');
  });

  it("recepción no ve «Configuración» ni las opciones exclusivas del médico", async () => {
    const { client } = await agendaClientFor(t, pool, "reception");
    const body = (await get("/agenda/dia/2026-06-16", client.cookie)).body;
    expect(navLinks(body)).toEqual(["/recepcion/panel", "/agenda", "/agenda/bloqueos"]);
    expect(activeLinks(body)).toEqual(["/agenda"]);
    expect(body).toContain("Recepción");
  });

  it("soporte ve su panel con la entrada actual resaltada y sin el <nav> propio de antes", async () => {
    const client = await sessionFor(t.services, await createSupportWithMfa(t, pool));
    const body = (await get("/soporte/metricas", client.cookie)).body;
    expect(navLinks(body)).toEqual(["/soporte", "/soporte/medicos", "/soporte/micrositios", "/soporte/correos", "/soporte/metricas", "/soporte/historial"]);
    expect(activeLinks(body)).toEqual(["/soporte/metricas"]);
    expect(body).not.toContain('<nav aria-label="Panel de soporte">');
  });

  it("la entrada activa es la de prefijo más largo y en /cuenta no hay ninguna", async () => {
    const { client } = await agendaClientFor(t, pool, "doctor");
    expect(activeLinks((await get("/agenda/dia/2026-06-16", client.cookie)).body)).toEqual(["/agenda"]);
    expect(activeLinks((await get("/cuenta/movil-emergencia", client.cookie)).body)).toEqual([]);
  });

  it("las pantallas del consultorio con sesión de paciente usan la barra del paciente; sin sesión, la tarjeta", async () => {
    const client = await sessionFor(t.services, (await createPatient(pool)).user);
    const withSession = (await get("/c/clinica-demo/entrar", client.cookie)).body;
    const anonymous = (await get("/c/clinica-demo/entrar")).body;
    for (const body of [withSession, anonymous]) expectDesigned(body, "consultorio");
    expect(anonymous).toMatch(/<body class="card-page( card-page--narrow)?">/);
  });
});

describe("sesión a medias", () => {
  it("con el segundo factor pendiente hay logo, rol y «Salir», sin navegación", async () => {
    const support = await createSupportWithMfa(t, pool);
    const { token } = await t.services.sessions.create(support.id, { mfaVerified: false });
    const body = (await get("/cuenta/mfa/alta", `${SESSION_COOKIE}=${token}`)).body;
    expect(body).toContain('class="has-shell"');
    expect(body).toContain('action="/logout"');
    expect(body).not.toContain('<nav aria-label="Principal">');
  });
});

describe("aviso de solo lectura", () => {
  it("una cuenta en solo lectura ve una alerta informativa arriba del contenido", async () => {
    const doctor = await createDoctor(pool);
    await setAccountState(pool, doctor.doctorId, "read_only");
    const client: AuthedClient = await sessionFor(t.services, doctor.user);
    const body = (await get("/agenda/bloqueos", client.cookie)).body;
    expect(body).toMatch(/<div class="alert alert--info" role="status">[\s\S]*Tu cuenta está en solo lectura/);
  });
});
