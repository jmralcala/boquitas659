import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, uniqueIp, type TestApp } from "./helpers/app.js";
import { createTestPool, resetDatabase } from "./helpers/db.js";

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

/** Rutas del contrato: filas de tabla con `GET /ruta`, `POST /ruta` o `GET/POST /ruta` entre comillas invertidas. */
function contractRoutes(): { method: string; url: string }[] {
  const text = readFileSync("specs/001-cuentas-y-acceso/contracts/http-routes.md", "utf8");
  const routes: { method: string; url: string }[] = [];
  for (const match of text.matchAll(/`(GET\/POST|GET|POST)\s+(\/[^`\s]*)`/g)) {
    const methods = match[1] === "GET/POST" ? ["GET", "POST"] : [match[1] as string];
    for (const method of methods) routes.push({ method, url: match[2] as string });
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
      expect(match[2], `${match[1]} debe recibir ctx: TenantContext`).toMatch(/^\s*ctx: TenantContext\b/);
    }
  });

  it("toda consulta de ese repositorio filtrada por médico usa ctx.doctorId", () => {
    const source = readFileSync("src/modules/patients/patient-repository.ts", "utf8");
    const scoped = source.split("export async function").filter((chunk) => /ForDoctor|ForMinor/.test(chunk.split("(")[0] ?? ""));
    for (const chunk of scoped) expect(chunk).toContain("ctx.doctorId");
  });
});
