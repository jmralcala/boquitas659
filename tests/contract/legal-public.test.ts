import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool, { RIGHTS_CONTACT_EMAIL: "derechos@example.com", RIGHTS_RESPONSE_DAYS: "15" });
});

beforeEach(async () => {
  await clearTables(pool);
  await t.services.legal.publish({ type: "patient_privacy", title: "Aviso de privacidad para pacientes", body: "Primer párrafo.\n\nSegundo <b>párrafo</b>.", isProvisional: true });
  await t.services.legal.publish({ type: "patient_privacy", title: "Aviso de privacidad para pacientes", body: "Versión revisada por el abogado.", isProvisional: false });
  await t.services.legal.publish({ type: "terms_doctor", title: "Términos para médicos", body: "Términos.", isProvisional: false });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string) => t.app.inject({ method: "GET", url });

describe("documentos legales sin sesión", () => {
  it("/legal lista la última versión de cada documento publicado, con enlaces", async () => {
    const response = await get("/legal");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Aviso de privacidad para pacientes");
    expect(response.body).toContain("/legal/patient_privacy");
    expect(response.body).toContain("Términos para médicos");
    expect(response.body).toContain("versión 2"); // la última del aviso de pacientes
  });

  it("/legal/:type muestra la última versión y /legal/:type/v/:version una anterior", async () => {
    const latest = await get("/legal/patient_privacy");
    expect(latest.statusCode).toBe(200);
    expect(latest.body).toContain("Versión revisada por el abogado.");
    expect(latest.body).not.toContain("TEXTO PROVISIONAL");

    const first = await get("/legal/patient_privacy/v/1");
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain("Primer párrafo.");
  });

  it("marca visiblemente los textos provisionales", async () => {
    const provisional = await get("/legal/patient_privacy/v/1");
    expect(provisional.body).toContain("provisional");
    const reviewed = await get("/legal/patient_privacy/v/2");
    expect(reviewed.body).not.toContain("provisional");
  });

  it("escapa el contenido del documento (no se interpreta HTML)", async () => {
    const response = await get("/legal/patient_privacy/v/1");
    expect(response.body).not.toContain("<b>párrafo</b>");
    expect(response.body).toContain("&lt;b&gt;párrafo&lt;/b&gt;");
  });

  it("devuelve 404 para tipos fuera de la lista cerrada, versiones inexistentes o documentos sin publicar", async () => {
    for (const url of ["/legal/otro_tipo", "/legal/patient_privacy/v/99", "/legal/reception_privacy", "/legal/..%2Fetc", "/legal/patient_privacy/v/0"]) {
      const response = await t.app.inject({ method: "GET", url, headers: { accept: "application/json" } });
      expect([400, 404], url).toContain(response.statusCode);
    }
    expect((await t.app.inject({ method: "GET", url: "/legal/otro_tipo", headers: { accept: "application/json" } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: "/legal/patient_privacy/v/abc", headers: { accept: "application/json" } })).statusCode).toBe(400);
  });

  it("/derechos muestra el canal y el plazo configurados", async () => {
    const response = await get("/derechos");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("derechos@example.com");
    expect(response.body).toContain("15 días hábiles");
    expect(response.body).toContain("15 días hábiles</strong> siguientes");
    for (const word of ["Acceso", "Rectificación", "Cancelación", "Oposición", "revocar el consentimiento", "limitar el uso o divulgación"]) {
      expect(response.body).toContain(word);
    }
  });

  it("el pie de las páginas públicas enlaza el aviso de privacidad y los derechos", async () => {
    for (const url of ["/login", "/pacientes/registro", "/medicos/registro", "/recuperar", "/legal", "/derechos"]) {
      const response = await get(url);
      expect(response.body, url).toContain('href="/legal"');
      expect(response.body, url).toContain('href="/derechos"');
    }
  });

  it("los formularios de registro enlazan el aviso que se acepta", async () => {
    expect((await get("/pacientes/registro")).body).toContain("/legal/patient_privacy");
    expect((await get("/medicos/registro")).body).toContain("/legal/doctor_privacy");
  });
});
