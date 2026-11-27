import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/http/session-plugin.js";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

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

const get = (url: string, cookie?: string, method: "GET" | "HEAD" = "GET", ip: string = uniqueIp()) =>
  t.app.inject({ method, url, remoteAddress: ip, headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });

const PAGES = ["/como-funciona", "/planes", "/nosotros"] as const;

const textOf = (fragment: string): string =>
  fragment
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const linksTo = (body: string, href: string): string[] =>
  [...body.matchAll(new RegExp(`<a\\b[^>]*href="${href.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</a>`, "g"))].map((match) => textOf(match[1] ?? ""));

const navOf = (body: string): string => /<nav aria-label="Principal">[\s\S]*?<\/nav>/.exec(body)?.[0] ?? "";

describe("exención de filtros globales (T003A)", () => {
  it("con un aviso legal pendiente las tres páginas se ven sin redirección, y la raíz sí redirige", async () => {
    const patient = await sessionFor(t.services, (await createPatient(pool)).user);
    await t.services.legal.publish({ type: "patient_privacy", title: "Aviso nuevo", body: "texto nuevo", isProvisional: false });
    for (const url of PAGES) expect((await get(url, patient.cookie)).statusCode, url).toBe(200);
    const root = await get("/", patient.cookie);
    expect(root.statusCode).toBe(303);
    expect(root.headers.location).toBe("/legal/aceptar");
  });

  it("soporte sin el segundo factor activo ve las tres páginas sin ser llevado a activarlo", async () => {
    const support = await sessionFor(t.services, await createUser(pool, { role: "support" }));
    for (const url of PAGES) expect((await get(url, support.cookie)).statusCode, url).toBe(200);
    expect((await get("/", support.cookie)).headers.location).toBe("/cuenta/mfa/alta");
  });
});

describe("US1: Cómo funciona", () => {
  it("explica qué es Agenda Dental, sus beneficios, funcionalidades y pasos", async () => {
    const response = await get("/como-funciona");
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/html");
    const body = response.body;
    expect(body).toContain("<title>Cómo funciona Agenda Dental</title>");
    expect(body).toContain('<meta name="description" content="Qué es Agenda Dental, sus beneficios y cómo funciona: tu micrositio propio para gestionar las citas de tu consultorio dental.">');
    expect(body.match(/<h1\b/g)).toHaveLength(1);
    expect(body).toContain("<h1>Cómo funciona Agenda Dental</h1>");
    expect(body).toContain("Agenda Dental es una solución diseñada y pensada especialmente para la comunidad de odontólogos en México. Mediante una suscripción, cada médico tiene su propio micrositio para llevar la gestión y el seguimiento de sus citas.");
    for (const title of ["Una agenda ordenada", "Sin dobles reservas", "Menos llamadas", "Menos inasistencias", "Tu propio micrositio", "Orden y privacidad"]) {
      expect(body, title).toContain(`<h3>${title}</h3>`);
    }
    expect(body.match(/<li class="info-card">/g)).toHaveLength(6);
    const checklist = /<h2>Lo que incluye<\/h2>[\s\S]*?<\/ul>/.exec(body)?.[0] ?? "";
    expect(checklist.match(/<li>/g)).toHaveLength(9);
    const orderedLists = body.match(/<ol class="steps">[\s\S]*?<\/ol>/g) ?? [];
    expect(orderedLists).toHaveLength(2);
    expect(orderedLists[0]?.match(/<li>/g)).toHaveLength(5);
    expect(orderedLists[1]?.match(/<li>/g)).toHaveLength(4);
    expect(body).toContain("Registro Nacional de Profesionistas");
  });

  it("cierra con «Regístrate aquí» y «Iniciar sesión» hacia el registro y el inicio de sesión", async () => {
    const body = (await get("/como-funciona")).body;
    const band = /<section class="cta-band">[\s\S]*?<\/section>/.exec(body)?.[0] ?? "";
    expect(linksTo(band, "/medicos/registro")).toEqual(["Regístrate aquí"]);
    expect(linksTo(band, "/login")).toEqual(["Iniciar sesión"]);
  });
});

describe("US2: Planes", () => {
  it("muestra los tres planes con precio anterior tachado y precio con descuento, sin centavos", async () => {
    const response = await get("/planes");
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain("<title>Planes de Agenda Dental</title>");
    expect(body).toContain('<meta name="description" content="Conoce los planes Esencial, Profesional y Élite de Agenda Dental, con 30 % de descuento de lanzamiento.">');
    expect(body.match(/<h1\b/g)).toHaveLength(1);
    expect(body).toContain("<h1>Planes</h1>");
    expect(body).toContain("Elige el plan para tu consultorio. Por lanzamiento, todos los planes tienen 30 % de descuento.");
    const cards = body.split('<li class="plan">').slice(1);
    expect(cards).toHaveLength(3);
    const expected: Array<[string, string, string]> = [["Esencial", "$499", "$349"], ["Profesional", "$999", "$699"], ["Élite", "$1,999", "$1,399"]];
    expected.forEach(([name, original, discounted], index) => {
      const card = cards[index] ?? "";
      expect(card, name).toContain(`<h2>${name}</h2>`);
      expect(card, name).toMatch(new RegExp(`<del class="price__old"><span class="visually-hidden">Precio anterior: </span>${original.replace("$", "\\$")}</del>`));
      expect(card, name).toMatch(new RegExp(`<span class="price__now"><span class="visually-hidden">Precio con descuento: </span>${discounted.replace("$", "\\$")}</span>`));
      expect(card, name).toContain("al mes · IVA incluido");
      expect(card, name).toContain("30 % de descuento");
      expect(card, name).not.toMatch(/\$\d[\d,]*\.\d\d/);
      expect(card, name).toContain('<span class="tag tag--soon">Próximamente</span>');
    });
    expect(cards[0]).toContain("Prueba de 5 días");
    expect(cards[1]).toContain("Sin prueba");
    expect(cards[2]).toContain("Sin prueba");
    expect(cards[0]).toContain("30 avisos de urgencia por WhatsApp al mes");
    expect(cards[1]).toContain("400 mensajes de WhatsApp al mes");
    expect(cards[2]).toContain("1,200 mensajes de WhatsApp al mes");
  });

  it("incluye la promoción, la nota de WhatsApp y la aclaración del cobro, y solo lleva al registro", async () => {
    const body = (await get("/planes")).body;
    const notes = /<ul class="notes">[\s\S]*?<\/ul>/.exec(body)?.[0] ?? "";
    expect(notes.match(/<li>/g)).toHaveLength(4);
    expect(notes).toContain("Promoción de lanzamiento por tiempo limitado. Precios y condiciones sujetos a cambio.");
    expect(notes).toContain("Precios en pesos mexicanos (MXN) por mes, con IVA incluido.");
    expect(notes).toContain("Hoy los avisos de Agenda Dental salen por correo. Los avisos por WhatsApp estarán disponibles próximamente.");
    expect(notes).toContain("Durante el piloto no se realiza ningún cobro. El cobro se activará más adelante y se te avisará con anticipación.");
    expect(linksTo(body, "/medicos/registro")).toEqual(["Registrarme", "Regístrate aquí", "Regístrate aquí", "Regístrate aquí"]);
    expect(body).not.toMatch(/\b(pagar|contratar|comprar)\b/i);
  });
});

describe("US4: barra de menú única", () => {
  it("las cuatro páginas comparten la misma barra y cada una marca solo su entrada", async () => {
    const pages: Array<[string, string]> = [["/", "Inicio"], ["/como-funciona", "Cómo funciona"], ["/planes", "Planes"], ["/nosotros", "Nosotros"]];
    const bars: string[] = [];
    for (const [url, label] of pages) {
      const nav = navOf((await get(url)).body);
      expect(nav, url).not.toBe("");
      const current = [...nav.matchAll(/<a href="([^"]+)" aria-current="page">([^<]+)<\/a>/g)].map((match) => match[2]);
      expect(current, url).toEqual([label]);
      bars.push(nav.replace(' aria-current="page"', ""));
    }
    for (const bar of bars) expect(bar).toBe(bars[0]);
  });

  it("el menú y el acceso tienen los destinos y el orden del contrato", async () => {
    const nav = navOf((await get("/planes")).body);
    const hrefs = [...nav.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(["/", "/como-funciona", "/planes", "/nosotros", "/medicos/registro", "/login"]);
    expect(textOf(nav)).toBe("Inicio Cómo funciona Planes Nosotros Registrarme Iniciar sesión");
    const body = (await get("/planes")).body;
    expect(body.match(/<nav aria-label="Principal">/g)).toHaveLength(1);
    expect(body).toMatch(/<a class="brand" href="\/">/);
  });
});

describe("US3: Nosotros", () => {
  it("dice que Agenda Dental es un producto de Innvend Works, con su enlace y su contacto", async () => {
    const response = await get("/nosotros");
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain("<title>Nosotros | Agenda Dental</title>");
    expect(body.match(/<h1\b/g)).toHaveLength(1);
    expect(textOf(body)).toContain("Agenda Dental es un producto desarrollado por Innvend Works");
    expect(body).toContain('<a href="https://www.innvend.com" target="_blank" rel="noopener noreferrer">www.innvend.com</a>');
    expect(body).toContain('<a href="mailto:contacto@innvend.com">contacto@innvend.com</a>');
    expect(body).toContain('<a href="tel:+523312415547">(52) 33 1241 5547</a>');
    expect(body).toContain("Este es el contacto de la empresa que desarrolla Agenda Dental; el enlace «Contacto» del pie es el de Agenda Dental.");
  });

  it("el único dominio externo es www.innvend.com y el pie conserva el correo de contacto de Agenda Dental", async () => {
    const body = (await get("/nosotros")).body;
    const hosts = new Set([...body.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => (match[1] ?? "").toLowerCase()));
    expect([...hosts].filter((host) => host !== "www.w3.org")).toEqual(["www.innvend.com"]);
    const footer = /<footer[\s\S]*<\/footer>/.exec(body)?.[0] ?? "";
    expect(linksTo(footer, "mailto:soporte@innvend.com")).toEqual(["Contacto"]);
  });
});

describe("US5: públicas para todos, ligeras y sin efectos", () => {
  it("responden 200 sin redirección a cualquiera: sin sesión, cada rol y con la sesión a medias", async () => {
    const patient = await sessionFor(t.services, (await createPatient(pool)).user);
    const doctor = await sessionFor(t.services, (await createDoctor(pool)).user);
    const reception = await sessionFor(t.services, await createUser(pool, { role: "reception" }));
    const support = await sessionFor(t.services, await createSupportWithMfa(t, pool));
    const half = await createSupportWithMfa(t, pool);
    const { token } = await t.services.sessions.create(half.id, { mfaVerified: false });
    const cookies: Array<string | undefined> = [undefined, patient.cookie, doctor.cookie, reception.cookie, support.cookie, `${SESSION_COOKIE}=${token}`];
    for (const url of PAGES) {
      const anonymous = (await get(url)).body;
      for (const cookie of cookies) {
        const response = await get(url, cookie);
        expect(response.statusCode, url).toBe(200);
        expect(response.body, url).toBe(anonymous);
      }
    }
  });

  it("sin formularios, scripts, estilos en línea ni cookies; íconos decorativos; un solo h1; menos de 30 KB", async () => {
    for (const url of PAGES) {
      const response = await get(url);
      const body = response.body;
      expect(body, url).not.toMatch(/<form\b/);
      expect(body, url).not.toMatch(/<input\b/);
      expect(body, url).not.toMatch(/<script\b/);
      expect(body, url).not.toMatch(/\sstyle\s*=/);
      expect(body, url).toContain('<meta name="robots" content="noindex">');
      expect(body, url).toContain('<body class="landing">');
      expect(body, url).toContain('href="#contenido">Saltar al contenido</a>');
      expect(body.match(/<h1\b/g), url).toHaveLength(1);
      for (const svg of body.match(/<svg\b[^>]*>/g) ?? []) expect(svg, url).toContain('aria-hidden="true"');
      expect(response.headers["set-cookie"], url).toBeUndefined();
      expect(response.headers["cache-control"], url).toBe("no-store");
      expect(Buffer.byteLength(body), url).toBeLessThan(30 * 1024);
    }
  });

  it("HEAD responde sin cuerpo y con las mismas cabeceras; los métodos y las variantes no son páginas", async () => {
    for (const url of PAGES) {
      const full = await get(url);
      const head = await get(url, undefined, "HEAD");
      expect(head.statusCode, url).toBe(200);
      expect(head.body, url).toBe("");
      expect(head.headers["content-security-policy"], url).toBe(full.headers["content-security-policy"]);
    }
    for (const url of ["/planes/x", "/Planes", "/precios", "/about", "/como_funciona"]) expect((await get(url)).statusCode, url).toBe(404);
    expect((await t.app.inject({ method: "POST", url: "/planes", remoteAddress: uniqueIp() })).statusCode).not.toBe(200);
  });

  it("limita las peticiones por IP: la 121 en un minuto da 429", async () => {
    const ip = "10.77.77.77";
    let last = 0;
    for (let index = 0; index < 121; index += 1) last = (await get("/planes", undefined, "GET", ip)).statusCode;
    expect(last).toBe(429);
  });
});
