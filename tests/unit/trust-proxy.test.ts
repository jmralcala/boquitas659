import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../../src/http/app.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function ipSeenBy(trustProxy: AppOptions["trustProxy"], forwarded: string): Promise<string> {
  app = await buildApp({ appEnv: "production", trustProxy });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/ip",
    remoteAddress: "10.0.0.1",
    headers: { "x-forwarded-for": forwarded },
  });
  return response.json().ip;
}

describe("trustProxy (el límite de peticiones depende de la IP real)", () => {
  it("por defecto ignora X-Forwarded-For: no se puede falsificar la IP", async () => {
    expect(await ipSeenBy(undefined, "6.6.6.6")).toBe("10.0.0.1");
    expect(await ipSeenBy(false, "6.6.6.6")).toBe("10.0.0.1");
  });

  it("con 1 salto toma la IP que añadió el proxy propio y no la que el cliente escribió antes", async () => {
    // El cliente envió "6.6.6.6"; el proxy propio (10.0.0.1) añadió la IP real "203.0.113.9".
    expect(await ipSeenBy(1, "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("con una lista de proxies solo confía en esos", async () => {
    expect(await ipSeenBy(["10.0.0.1"], "203.0.113.9")).toBe("203.0.113.9");
    expect(await ipSeenBy(["192.168.0.1"], "203.0.113.9")).toBe("10.0.0.1");
  });
});
