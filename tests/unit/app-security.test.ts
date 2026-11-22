import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../../src/http/app.js";
import { parseInput } from "../../src/http/validate.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

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

const formSchema = z.object({ email: z.email(), age: z.coerce.number().int().min(18) });

async function appWithRoutes(logStream?: Writable): Promise<FastifyInstance> {
  const instance = await buildApp({ appEnv: "production", logStream });
  instance.get("/ok", async () => ({ ok: true }));
  instance.post("/formulario", async (request) => parseInput(formSchema, request.body));
  instance.get("/falla", async () => {
    const error = new Error("Duplicate entry 'ana@example.com' for key 'email' at C:\\interno\\archivo.ts") as Error & {
      code: string;
    };
    error.code = "ER_DUP_ENTRY";
    throw error;
  });
  instance.get(
    "/limitada",
    { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } },
    async () => ({ ok: true }),
  );
  await instance.ready();
  return instance;
}

describe("buildApp: cabeceras y errores", () => {
  it("envía cabeceras de seguridad", async () => {
    app = await appWithRoutes();
    const response = await app.inject({ method: "GET", url: "/ok" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["strict-transport-security"]).toBeDefined();
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("la validación zod devuelve 400 con mensajes por campo", async () => {
    app = await appWithRoutes();
    const response = await app.inject({
      method: "POST",
      url: "/formulario",
      headers: { accept: "application/json" },
      payload: { email: "no-es-correo", age: "12" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe("validation_error");
    expect(Object.keys(body.fields).sort()).toEqual(["age", "email"]);
  });

  it("una ruta inexistente devuelve 404 sin detalles internos", async () => {
    app = await appWithRoutes();
    const response = await app.inject({ method: "GET", url: "/no-existe", headers: { accept: "application/json" } });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("Route");
    expect(response.body).not.toContain("/no-existe");
  });

  it("un error interno devuelve 500 sin mensaje ni traza, y se registra solo con tipo y código", async () => {
    const { stream, output } = captureStream();
    app = await appWithRoutes(stream);
    const response = await app.inject({ method: "GET", url: "/falla", headers: { accept: "application/json" } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("Duplicate");
    expect(response.body).not.toContain("ana@example.com");
    expect(response.body).not.toContain("interno");
    const log = output();
    expect(log).toContain("ER_DUP_ENTRY");
    expect(log).not.toContain("ana@example.com");
  });

  it("responde HTML a navegadores y JSON a clientes que lo piden", async () => {
    app = await appWithRoutes();
    const html = await app.inject({ method: "GET", url: "/no-existe", headers: { accept: "text/html" } });
    expect(html.headers["content-type"]).toContain("text/html");
    const json = await app.inject({ method: "GET", url: "/no-existe", headers: { accept: "application/json" } });
    expect(json.headers["content-type"]).toContain("application/json");
  });

  it("el límite de peticiones responde 429", async () => {
    app = await appWithRoutes();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: "GET", url: "/limitada", headers: { accept: "application/json" } });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});
