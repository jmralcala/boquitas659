import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, uniqueIp, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const get = (url: string, ip = uniqueIp(), method: "GET" | "HEAD" = "GET") => t.app.inject({ method, url, remoteAddress: ip, headers: { accept: "*/*" } });

const FONTS = ["/assets/fonts/inter-var-latin.woff2", "/assets/fonts/manrope-var-latin.woff2"];

describe("recursos del diseño (/assets)", () => {
  it("sirve la hoja con tipo fijo, caché larga y nosniff", async () => {
    const response = await get("/assets/styles.css");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toContain(":root");
  });

  it.each(FONTS)("sirve la fuente %s", async (url) => {
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("font/woff2");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.length).toBeGreaterThan(10_000);
    expect(response.headers["cache-control"]).not.toContain("no-store");
  });

  it("responde a HEAD sin cuerpo", async () => {
    const response = await get("/assets/styles.css", uniqueIp(), "HEAD");
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
  });

  it("cualquier nombre fuera de la lista da el mismo 404 que una ruta inexistente", async () => {
    const unknown = await get("/ruta-que-no-existe");
    for (const url of ["/assets/otro.css", "/assets/fonts/x.woff2", "/assets/../package.json", "/assets/%2e%2e/package.json", "/assets/fonts/", "/assets/", "/assets/STYLES.CSS", "/assets/styles.css/extra"]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).toBe(unknown.body);
    }
  });

  it("solo admite GET y HEAD", async () => {
    const response = await t.app.inject({ method: "POST", url: "/assets/styles.css", remoteAddress: uniqueIp() });
    expect([404, 405, 403]).toContain(response.statusCode);
  });

  it("la URL de la hoja que enlaza una página lleva el hash de su contenido", async () => {
    const page = await get("/login");
    const match = /href="\/assets\/styles\.css\?v=([a-z0-9]+)"/.exec(page.body);
    expect(match).not.toBeNull();
    expect(match?.[1]?.length).toBeGreaterThanOrEqual(6);
  });

  it("tiene su propio límite de peticiones: 600 por minuto por IP", async () => {
    const ip = "10.251.251.251";
    let status = 0;
    for (let index = 0; index < 601; index += 1) status = (await get("/assets/styles.css", ip)).statusCode;
    expect(status).toBe(429);
    expect((await get("/assets/styles.css")).statusCode).toBe(200);
  }, 120_000);
});

describe("política de seguridad de contenido (FR-016, FR-017)", () => {
  it("solo admite recursos propios: sin https: ni unsafe-inline y con las directivas del contrato", async () => {
    const header = String((await get("/login")).headers["content-security-policy"]);
    for (const directive of [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self' data:",
      "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ]) {
      expect(header, directive).toContain(directive);
    }
    expect(header).not.toContain("https:");
    expect(header).not.toContain("unsafe-inline");
    expect(header).not.toContain("unsafe-eval");
  });

  it("las páginas HTML siguen sin guardarse en caché mientras los recursos sí se cachean", async () => {
    expect((await get("/login")).headers["cache-control"]).toBe("no-store");
    expect((await get("/assets/styles.css")).headers["cache-control"]).not.toContain("no-store");
  });
});
