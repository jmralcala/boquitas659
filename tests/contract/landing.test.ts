import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/http/session-plugin.js";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let tOther: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
  tOther = await createTestApp(pool, { RIGHTS_CONTACT_EMAIL: "otro@example.com" });
});

beforeEach(async () => {
  await clearTables(pool);
  t.clock.set(new Date("2026-11-26T18:00:00.000Z"));
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await tOther.app.close();
  await pool.end();
});

const get = (url: string, cookie?: string, app: TestApp = t, method: "GET" | "HEAD" = "GET") =>
  app.app.inject({ method, url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });

const linksTo = (body: string, href: string): string[] =>
  [...body.matchAll(new RegExp(`<a\\b[^>]*href="${href.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</a>`, "g"))].map((match) =>
    (match[1] ?? "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  );

describe("US1: el médico conoce el servicio y empieza su registro", () => {
  it("la raíz responde con la portada sin sesión, con los textos veraces del contrato", async () => {
    const response = await get("/");
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/html");
    const body = response.body;
    expect(body).toContain("<title>Agenda Dental: agenda en línea para consultorios dentales</title>");
    expect(body).toMatch(/<meta name="description" content="[^"]*reservan y cancelan sus citas desde el celular[^"]*">/);
    expect(body).toContain("Agenda en línea para consultorios dentales");
    expect(body).toMatch(/<h1>[\s\S]*Tu consultorio, en orden\.[\s\S]*Tus pacientes, a un mensaje de distancia\.[\s\S]*<\/h1>/);
    expect(body).toContain("Tus pacientes prefieren agendar como hacen todo lo demás: desde su celular, en segundos y sin llamadas.");
    expect(body).toContain("reservar y cancelar sus citas en línea y recibir avisos por correo");
    expect(body).toContain("La agenda es el punto de partida de un consultorio que funciona bien.");
    expect(body).toContain("Con ella bien gestionada puedes:");
    for (const card of [
      "Planear con certeza tu semana, con los horarios, la duración de cita y los bloqueos que tú eliges.",
      "Aprovechar al máximo cada consulta: tus pacientes solo reservan espacios libres, sin dobles reservas.",
      "Cumplir los tiempos de cada consulta con la duración y la pausa que tú configuras.",
      "Reducir las inasistencias con recordatorios por correo.",
      "Mantener tu agenda y los datos de tus pacientes separados de los de otros consultorios.",
    ]) {
      expect(body, card).toContain(card);
    }
    expect(body).toContain("Menos llamadas y una agenda más ordenada.");
    expect(body).toContain("Crea la cuenta de tu consultorio y empieza a recibir citas en línea. Revisamos cada solicitud antes de activar la cuenta.");
  });

  it("hay exactamente tres enlaces al registro de médicos con sus textos y ningún formulario, script ni estilo en línea", async () => {
    const body = (await get("/")).body;
    expect(linksTo(body, "/medicos/registro")).toEqual(["Registrarme", "Regístrate aquí", "Regístrate aquí"]);
    expect(body).not.toMatch(/<form\b/);
    expect(body).not.toMatch(/<input\b/);
    expect(body).not.toMatch(/<script\b/);
    expect(body).not.toMatch(/\sstyle\s*=/);
    expect(body).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(body).toContain('<meta name="robots" content="noindex">');
  });
});

describe("US2: quien ya tiene cuenta entra sin buscar el enlace", () => {
  it("hay exactamente dos enlaces al inicio de sesión: «Iniciar sesión» y «Ya tengo cuenta»", async () => {
    expect(linksTo((await get("/")).body, "/login")).toEqual(["Iniciar sesión", "Ya tengo cuenta"]);
  });

  it("con sesión completa redirige al inicio del rol, sin mostrar la portada", async () => {
    const patient = await sessionFor(t.services, (await createPatient(pool)).user);
    const doctor = await sessionFor(t.services, (await createDoctor(pool)).user);
    const reception = await sessionFor(t.services, await createUser(pool, { role: "reception" }));
    const support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
    const expected: Array<[string, string, string]> = [
      ["paciente", patient.cookie, "/pacientes/panel"],
      ["médico", doctor.cookie, "/medicos/inicio"],
      ["recepción", reception.cookie, "/recepcion/panel"],
      ["soporte", support.cookie, "/soporte/medicos"],
    ];
    for (const [who, cookie, location] of expected) {
      const response = await get("/", cookie);
      expect(response.statusCode, who).toBe(303);
      expect(response.headers.location, who).toBe(location);
      expect(response.body, who).not.toContain("Tu consultorio, en orden.");
    }
  });

  it("con la sesión a medias (segundo factor pendiente) muestra la portada", async () => {
    const support = await createSupportWithMfa(t, pool);
    const { token } = await t.services.sessions.create(support.id, { mfaVerified: false });
    const response = await get("/", `${SESSION_COOKIE}=${token}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Tu consultorio, en orden.");
  });

  it("soporte sin el segundo factor activo es llevado a activarlo antes que a su área (filtro global)", async () => {
    const client = await sessionFor(t.services, await createUser(pool, { role: "support" }));
    const response = await get("/", client.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/cuenta/mfa/alta");
  });

  it("con avisos legales pendientes el filtro global lleva a aceptarlos antes que a su área", async () => {
    const patient = await sessionFor(t.services, (await createPatient(pool)).user);
    await t.services.legal.publish({ type: "patient_privacy", title: "Aviso nuevo", body: "texto nuevo", isProvisional: false });
    const response = await get("/", patient.cookie);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/legal/aceptar");
  });
});

describe("US3: se lee bien en el celular y es accesible", () => {
  it("tiene un solo h1, regiones, salto al contenido e íconos decorativos, sin barra lateral ni «Salir»", async () => {
    const body = (await get("/")).body;
    expect(body.match(/<h1\b/g)).toHaveLength(1);
    expect(body).toContain("<header");
    expect(body).toContain('<main id="contenido">');
    expect(body).toContain("<footer");
    expect(body).toMatch(/<a class="skip-link" href="#contenido">Saltar al contenido<\/a>/);
    const svgs = body.match(/<svg\b[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThanOrEqual(8);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
    expect(body).not.toContain('class="has-shell"');
    expect(body).not.toContain("<aside");
    expect(body).not.toContain('action="/logout"');
    expect(body).toContain('lang="es"');
    expect(body).toContain('name="viewport"');
  });

  it("no establece cookies, no se guarda en caché y pesa menos de 30 KB", async () => {
    const response = await get("/");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Buffer.byteLength(response.body)).toBeLessThan(30 * 1024);
  });

  it("HEAD responde sin cuerpo y con las mismas cabeceras", async () => {
    const full = await get("/");
    const response = await get("/", undefined, t, "HEAD");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(String(response.headers["content-type"])).toContain("text/html");
    expect(response.headers["cache-control"]).toBe(full.headers["cache-control"]);
    expect(response.headers["content-security-policy"]).toBe(full.headers["content-security-policy"]);
  });
});

describe("US4: contacto y textos legales a la vista", () => {
  it("el pie enlaza los textos legales de médico y el correo de contacto", async () => {
    const body = (await get("/")).body;
    const footer = /<footer[\s\S]*<\/footer>/.exec(body)?.[0] ?? "";
    expect(linksTo(footer, "/legal/doctor_privacy")).toEqual(["Aviso de privacidad"]);
    expect(linksTo(footer, "/legal/terms_doctor")).toEqual(["Términos y condiciones"]);
    expect(linksTo(footer, "mailto:soporte@innvend.com")).toEqual(["Contacto"]);
  });

  it("muestra el año del reloj del servidor", async () => {
    expect((await get("/")).body).toContain("© 2026 Agenda Dental");
    t.clock.set(new Date("2027-03-01T18:00:00.000Z"));
    expect((await get("/")).body).toContain("© 2027 Agenda Dental");
  });

  it("el correo de contacto sale de la configuración y se escapa", async () => {
    const body = (await get("/", undefined, tOther)).body;
    expect(body).toContain('href="mailto:otro@example.com"');
    expect(body).not.toContain("soporte@innvend.com");
  });
});
