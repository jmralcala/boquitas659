import type { FastifyRequest } from "fastify";

/** Verdadero si el cliente pidió JSON (pruebas y clientes programáticos); los navegadores reciben HTML. */
export function wantsJson(request: FastifyRequest): boolean {
  return (request.headers.accept ?? "").includes("application/json");
}
