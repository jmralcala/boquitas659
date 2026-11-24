import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPatientContext } from "../../src/lib/tenant.js";
import { reserveAsPatient } from "../../src/modules/site/booking-service.js";
import { createTestApp, linkTokenSentTo, sessionFor, uniqueIp, type TestApp } from "./helpers/app.js";
import { createAppointment, createDoctor, createPatient, createPublishedSite, createTestPool, ensurePrivacyDocument, resetDatabase } from "./helpers/db.js";

/**
 * Auditoría de rutas (T120): contrasta lo REGISTRADO con `contracts/http-routes.md` y comprueba, para todas las
 * rutas, CSRF en las que cambian estado y sesión en las que no son públicas.
 */
const pool = createTestPool();
let t: TestApp;
const registered: { method: string; url: string }[] = [];

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, {}, {
    onRoute: (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== "HEAD" && method !== "OPTIONS") registered.push({ method, url: route.url });
      }
    },
  });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const normalize = (url: string): string => url.replace(/:[A-Za-z]+/g, ":p");
const concrete = (url: string): string => url.replace(/:token/g, "a".repeat(43)).replace(/:[A-Za-z]+/g, "1");

/** Contratos de rutas de cada feature (la 002 es la agenda del médico). */
const CONTRACT_FILES = [
  "specs/001-cuentas-y-acceso/contracts/http-routes.md",
  "specs/002-calendario-del-medico/contracts/http-routes.md",
  "specs/003-micrositio-y-reserva-del-paciente/contracts/http-routes.md",
];

/** Rutas del contrato: filas de tabla con `GET /ruta`, `POST /ruta` o `GET/POST /ruta` entre comillas invertidas. */
function contractRoutes(): { method: string; url: string }[] {
  const routes: { method: string; url: string }[] = [];
  for (const file of CONTRACT_FILES) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/`(GET\/POST|GET|POST)\s+(\/[^`\s]*)`/g)) {
      const methods = match[1] === "GET/POST" ? ["GET", "POST"] : [match[1] as string];
      for (const method of methods) routes.push({ method, url: match[2] as string });
    }
  }
  return routes;
}

// Pantallas públicas por diseño (sin sesión): se verifican aparte.
const PUBLIC_GET = new Set([
  "/login",
  "/login/mfa",
  "/recuperar",
  "/recuperar/:token",
  "/medicos/registro",
  "/pacientes/registro",
  "/recepcion/invitacion/:token",
  "/cuenta/correo/confirmar/:token",
  "/legal",
  "/legal/:type",
  "/legal/:type/v/:version",
  "/derechos",
  // Feature 3: el micrositio y la entrada del paciente son públicos; reservar y el paciente adicional redirigen (303) sin sesión.
  "/c/:slug",
  "/c/:slug/logo",
  "/c/:slug/entrar",
  "/c/:slug/primera-cita",
  "/c/:slug/reservar",
  "/c/:slug/paciente-adicional",
  "/citas/enlace/:token",
]);

describe("las rutas registradas coinciden con el contrato", () => {
  it("toda ruta del contrato está registrada", () => {
    const have = new Set(registered.map((r) => `${r.method} ${normalize(r.url)}`));
    const missing = contractRoutes()
      .map((r) => `${r.method} ${normalize(r.url)}`)
      .filter((key) => !have.has(key));
    expect([...new Set(missing)]).toEqual([]);
  });

  it("toda ruta registrada está en el contrato (no hay rutas sin documentar)", () => {
    const documented = new Set(contractRoutes().map((r) => `${r.method} ${normalize(r.url)}`));
    const undocumented = registered.map((r) => `${r.method} ${normalize(r.url)}`).filter((key) => !documented.has(key));
    expect([...new Set(undocumented)]).toEqual([]);
  });
});

describe("CSRF en toda ruta que cambia estado", () => {
  it("un POST sin token CSRF responde 403 en TODAS las rutas POST", async () => {
    const posts = registered.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(15);
    const failures: string[] = [];
    for (const route of posts) {
      const response = await t.app.inject({
        method: "POST",
        url: concrete(route.url),
        remoteAddress: uniqueIp(),
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1",
      });
      if (response.statusCode !== 403) failures.push(`${route.url} → ${response.statusCode}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("sesión en las rutas que no son públicas", () => {
  it("sin sesión, todo GET que no es público responde 401", async () => {
    const protectedGets = registered.filter((r) => r.method === "GET" && !PUBLIC_GET.has(r.url));
    expect(protectedGets.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const route of protectedGets) {
      const response = await t.app.inject({
        method: "GET",
        url: concrete(route.url),
        remoteAddress: uniqueIp(),
        headers: { accept: "application/json" },
      });
      if (response.statusCode !== 401) failures.push(`${route.url} → ${response.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it("las pantallas públicas responden sin sesión (no piden iniciar sesión)", async () => {
    const failures: string[] = [];
    for (const url of PUBLIC_GET) {
      const response = await t.app.inject({ method: "GET", url: concrete(url), remoteAddress: uniqueIp(), headers: { accept: "text/html" } });
      // 200 (formulario o texto), 303 (redirige a /login) o 404/410 (token o documento inexistente): nunca 401.
      if (response.statusCode === 401) failures.push(`${url} → 401`);
    }
    expect(failures).toEqual([]);
  });
});

describe("datos de pacientes: siempre con el contexto de médico", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
    });
  }

  it("las lecturas de la tabla patient (FROM o JOIN) solo existen en patient-repository.ts", () => {
    const offenders = sourceFiles("src")
      .filter((file) => !file.replace(/\\/g, "/").endsWith("src/modules/patients/patient-repository.ts"))
      .filter((file) => /\b(FROM|JOIN)\s+`?patient`?\s/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("toda función del repositorio pensada para un médico recibe el TenantContext como primer parámetro", () => {
    const source = readFileSync("src/modules/patients/patient-repository.ts", "utf8");
    const forDoctor = [...source.matchAll(/export async function (\w+)\(([^)]*)\)/g)].filter(
      (m) => /ForDoctor|ForMinor/.test(m[1] as string),
    );
    expect(forDoctor.length).toBeGreaterThanOrEqual(3);
    for (const match of forDoctor) {
      expect(match[2], `${match[1]} debe recibir ctx: StaffContext o TenantContext`).toMatch(/^\s*ctx: (?:Staff|Tenant)Context\b/);
    }
  });

  it("toda consulta de ese repositorio filtrada por médico usa ctx.doctorId", () => {
    const source = readFileSync("src/modules/patients/patient-repository.ts", "utf8");
    const scoped = source.split("export async function").filter((chunk) => /ForDoctor|ForMinor/.test(chunk.split("(")[0] ?? ""));
    for (const chunk of scoped) expect(chunk).toContain("ctx.doctorId");
  });
});

describe("agenda: siempre con el contexto de médico", () => {
  const calendarFiles = [
    "appointment-repository.ts",
    "block-repository.ts",
    "settings-repository.ts",
    "agenda-service.ts",
    "appointment-service.ts",
    "block-service.ts",
    "action-log.ts",
    "calendar-lock.ts",
  ].map((name) => `src/modules/calendar/${name}`);

  // Funciones puras (sin base de datos ni datos de ningún médico): no reciben contexto.
  const PURE = new Set(["parseLocalStart"]);

  it("toda función exportada de los repositorios y servicios de agenda recibe el TenantContext como primer parámetro", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of calendarFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/export (?:async )?function (\w+)(?:<[^>]*>)?\(\s*([^)]*)\)/g)) {
        if (PURE.has(match[1] as string)) continue;
        checked += 1;
        if (!/^ctx: (?:Staff|Tenant)Context\b/.test((match[2] ?? "").trim())) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(offenders).toEqual([]);
  });

  it("toda función de los repositorios de citas y bloqueos filtra por el médico del contexto (ctx.doctorId)", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of ["appointment-repository.ts", "block-repository.ts"].map((name) => `src/modules/calendar/${name}`)) {
      const chunks = readFileSync(file, "utf8").split("export async function").slice(1);
      for (const chunk of chunks) {
        checked += 1;
        if (!chunk.includes("ctx.doctorId")) offenders.push(`${file}: ${chunk.split("(")[0]?.trim()}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });

  it("las rutas de agenda obtienen el médico del contexto, nunca de la petición", () => {
    const source = readFileSync("src/modules/calendar/routes.ts", "utf8");
    expect(source).not.toMatch(/doctorId\s*[:=]\s*(?:request|body|params|query)/);
    expect(source).not.toMatch(/request\.(?:body|params|query)[^;]*doctorId/);
    // Cada manejador resuelve el contexto con el resolutor de la feature 1 como primera acción.
    const handlers = [...source.matchAll(/app\.(?:get|post)\("[^"]+",\s*async \(request, reply\) => \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*const tenant = await ([\w.]+)\(/g)];
    expect(handlers.length).toBeGreaterThanOrEqual(14);
  });
});

describe("feature 3: ningún GET de /c/ ni de /citas/ cambia estado", () => {
  const TABLES = ["appointment", "one_time_token", "doctor_patient", "data_authorization", "email_outbox", "calendar_action_log", "doctor_site", "patient"];

  async function snapshot(): Promise<string> {
    const parts: unknown[] = [];
    for (const table of TABLES) parts.push((await pool.query(`SELECT * FROM \`${table}\` ORDER BY 1`))[0]);
    return JSON.stringify(parts);
  }

  it("recorrerlos (sin sesión, con la sesión del paciente y con un token real) deja la base idéntica", async () => {
    await ensurePrivacyDocument(pool);
    t.clock.set(new Date("2026-06-15T14:00:00.000Z"));
    const doctor = await createDoctor(pool);
    await createPublishedSite(pool, doctor, { slug: "clinica-rios" });
    const patient = await createPatient(pool, { email: "auditoria@example.com" });
    await reserveAsPatient(createPatientContext(doctor.doctorId, patient.user.id), { db: pool, clock: t.clock }, { startLocal: "2026-06-17T10:00", patientId: patient.patientId, authorize: true });
    await createAppointment(pool, { doctorId: doctor.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-20T16:00:00.000Z") });
    const token = await linkTokenSentTo(t, "auditoria@example.com", "/citas/enlace");
    const client = await sessionFor(t.services, patient.user);

    const before = await snapshot();
    const urls = registered
      .filter((r) => r.method === "GET" && (r.url.startsWith("/c/") || r.url.startsWith("/citas/") || r.url.startsWith("/pacientes/")))
      .map((r) => r.url.replace(":slug", "clinica-rios").replace(":token", token).replace(/:[A-Za-z]+/g, "1"));
    expect(urls.length).toBeGreaterThanOrEqual(10);
    for (const url of urls) {
      for (const cookie of [undefined, client.cookie]) {
        await t.app.inject({ method: "GET", url, remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
      }
    }
    expect(await snapshot()).toBe(before);
  });
});
