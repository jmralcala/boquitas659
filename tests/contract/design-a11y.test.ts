import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createAppointment, createDoctor, createPatient, createPublishedSite, createTestPool, createUser, ensurePrivacyDocument, resetDatabase } from "../integration/helpers/db.js";
import { agendaClientFor, createSupportWithMfa, createTestApp, sessionFor, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
const getRoutes: string[] = [];
const NOW = new Date("2026-06-15T14:00:00.000Z");

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
  t.clock.set(NOW);
  await ensurePrivacyDocument(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const NOT_SCREENS = new Set(["/assets/styles.css", "/assets/fonts/inter-var-latin.woff2", "/assets/fonts/manrope-var-latin.woff2", "/c/:slug/logo", "/soporte/medicos/:id/cedula"]);
const SAMPLE: Record<string, string> = { ":token": "a".repeat(43), ":slug": "clinica-rios", ":fecha": "2026-06-16", ":type": "patient_privacy", ":version": "1" };
const concrete = (url: string): string => url.replace(/:[A-Za-z]+/g, (name) => SAMPLE[name] ?? "1");

/** Controles de formulario visibles de una página con el nombre accesible que les falta (vacío si todo está bien). */
function unlabeledControls(body: string): string[] {
  const labelRanges = [...body.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
  const labelFor = new Set([...body.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((match) => match[1] as string));
  const missing: string[] = [];
  for (const match of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attributes = match[2] ?? "";
    if (/type="(hidden|submit|button)"/.test(attributes)) continue;
    const index = match.index ?? 0;
    const inLabel = labelRanges.some(([start, end]) => index >= start && index < end);
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    const named = /aria-label="[^"]+"|aria-labelledby="[^"]+"/.test(attributes) || (id !== undefined && labelFor.has(id));
    if (!inLabel && !named) missing.push(match[0].slice(0, 80));
  }
  return missing;
}

function emptyButtons(body: string): string[] {
  const bad: string[] = [];
  for (const match of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const text = (match[2] ?? "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    if (text === "" && !/aria-label="[^"]+"/.test(match[1] ?? "")) bad.push(match[0].slice(0, 80));
  }
  return bad;
}

describe("accesibilidad de todas las pantallas (FR-014, SC-008)", () => {
  it("cada pantalla HTML tiene un solo h1, controles con etiqueta, botones con nombre, th con alcance e imágenes con alt", async () => {
    const doctorAgenda = await agendaClientFor(t, pool, "doctor");
    const patient = await createPatient(pool);
    const clinic = await createDoctor(pool, { fullName: "Dra. Elena Ríos" });
    await createPublishedSite(pool, clinic, { slug: "clinica-rios" });
    await createAppointment(pool, { doctorId: clinic.doctorId, patientId: patient.patientId, startUtc: new Date("2026-06-20T16:00:00.000Z") });
    const sessions: Array<[string, string | undefined]> = [
      ["anónimo", undefined],
      ["paciente", (await sessionFor(t.services, patient.user)).cookie],
      ["médico", doctorAgenda.client.cookie],
      ["recepción", (await sessionFor(t.services, await createUser(pool, { role: "reception" }))).cookie],
      ["soporte", (await sessionFor(t.services, await createSupportWithMfa(t, pool))).cookie],
    ];

    const problems: string[] = [];
    let checked = 0;
    for (const url of [...new Set(getRoutes)].filter((route) => !NOT_SCREENS.has(route))) {
      for (const [who, cookie] of sessions) {
        const response = await t.app.inject({ method: "GET", url: concrete(url), remoteAddress: uniqueIp(), headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
        if (!String(response.headers["content-type"] ?? "").startsWith("text/html") || response.statusCode >= 300 && response.statusCode < 400) continue;
        checked += 1;
        const body = response.body;
        const label = `${who} ${url} (${response.statusCode})`;
        const h1 = body.match(/<h1\b/g)?.length ?? 0;
        if (h1 !== 1) problems.push(`${label}: ${h1} h1`);
        for (const control of unlabeledControls(body)) problems.push(`${label}: control sin etiqueta ${control}`);
        for (const button of emptyButtons(body)) problems.push(`${label}: botón sin nombre ${button}`);
        for (const th of body.matchAll(/<th\b([^>]*)>/g)) if (!/scope="col"|scope="row"/.test(th[1] ?? "")) problems.push(`${label}: th sin scope`);
        for (const img of body.matchAll(/<img\b([^>]*)>/g)) if (!/\balt="/.test(img[1] ?? "")) problems.push(`${label}: img sin alt`);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect([...new Set(problems)]).toEqual([]);
  }, 300_000);

  it("la hoja respeta «reducir movimiento» y define el foco visible", () => {
    const styles = readFileSync(join(ROOT, "src", "http", "assets", "styles.css"), "utf8");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(/transition:\s*none\s*!important/);
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("var(--focus-ring)");
  });
});
