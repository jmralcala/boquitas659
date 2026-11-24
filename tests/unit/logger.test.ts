import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "../../src/http/logger.js";

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, output: () => chunks.join("") };
}

describe("loggerOptions", () => {
  it("redacta la categoría del triaje, las señales de alarma y el token del CAPTCHA aunque algún día se registre el cuerpo", async () => {
    const { stream, output } = captureStream();
    const app = Fastify({ logger: { ...loggerOptions("production"), stream } });
    app.post("/c/:slug/urgencia", async (request) => {
      request.log.info({ categoria: "rojo-reconocible", senales: ["hinchazon-reconocible"], "cf-turnstile-response": "captcha-reconocible" }, "directo");
      request.log.info({ body: { category: "naranja-reconocible", categoria: "amarillo-reconocible", "cf-turnstile-response": "captcha-anidado-reconocible" } }, "anidado");
      return { ok: true };
    });
    await app.inject({ method: "POST", url: "/c/clinica/urgencia", headers: { "content-type": "application/json" }, payload: { categoria: "verde-reconocible" } });
    await app.close();
    const log = output();
    expect(log).toContain("directo");
    expect(log).toContain("anidado");
    for (const secreto of ["rojo-reconocible", "hinchazon-reconocible", "captcha-reconocible", "naranja-reconocible", "amarillo-reconocible", "captcha-anidado-reconocible", "verde-reconocible"]) {
      expect(log).not.toContain(secreto);
    }
  });

  it("no registra autorización, cookies, cuerpos, tokens de la URL ni datos personales", async () => {
    const { stream, output } = captureStream();
    const app = Fastify({ logger: { ...loggerOptions("production"), stream } });
    app.post("/recuperar/:token", async (request) => {
      request.log.info({ password: "clave-secreta-de-prueba", email: "ana@example.com" }, "evento de prueba");
      return { ok: true };
    });

    await app.inject({
      method: "POST",
      url: "/recuperar/TOKEN-SECRETO-EN-LA-URL?correo=ana@example.com",
      headers: {
        authorization: "Bearer valor-secreto",
        cookie: "__Host-sid=cookie-secreta",
        "content-type": "application/json",
      },
      payload: { password: "clave-secreta-de-prueba", email: "ana@example.com" },
    });
    await app.close();

    const log = output();
    expect(log.length).toBeGreaterThan(0);
    for (const secreto of [
      "valor-secreto",
      "cookie-secreta",
      "clave-secreta-de-prueba",
      "TOKEN-SECRETO-EN-LA-URL",
      "ana@example.com",
    ]) {
      expect(log).not.toContain(secreto);
    }
    expect(log).toContain("/recuperar/:token");
  });
});
