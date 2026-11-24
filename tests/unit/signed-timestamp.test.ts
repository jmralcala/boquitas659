import { describe, expect, it } from "vitest";
import { OPENED_AT_MAX_AGE_MS, signOpenedAt, verifyOpenedAt } from "../../src/lib/signed-timestamp.js";

const SECRET = "secreto-de-la-sesion-".repeat(2);
const OPENED = new Date("2026-06-15T14:00:00.000Z");
const later = (ms: number) => new Date(OPENED.getTime() + ms);

describe("hora de apertura firmada", () => {
  it("se verifica con el mismo secreto y devuelve la hora original", () => {
    const token = signOpenedAt(SECRET, OPENED);
    expect(verifyOpenedAt(SECRET, token, later(90_000))?.toISOString()).toBe(OPENED.toISOString());
  });

  it("una firma alterada, una hora cambiada o otro secreto son inválidos", () => {
    const token = signOpenedAt(SECRET, OPENED);
    const [millis, signature] = token.split(".") as [string, string];
    expect(verifyOpenedAt(SECRET, `${millis}.${signature.slice(0, -1)}0`, later(1000))).toBeNull();
    expect(verifyOpenedAt(SECRET, `${Number(millis) - 60_000}.${signature}`, later(1000))).toBeNull();
    expect(verifyOpenedAt("otro-secreto".repeat(4), token, later(1000))).toBeNull();
  });

  it("de más de 60 minutos o de una hora futura es inválida", () => {
    const token = signOpenedAt(SECRET, OPENED);
    expect(verifyOpenedAt(SECRET, token, later(OPENED_AT_MAX_AGE_MS))).not.toBeNull();
    expect(verifyOpenedAt(SECRET, token, later(OPENED_AT_MAX_AGE_MS + 1))).toBeNull();
    expect(verifyOpenedAt(SECRET, token, later(-1))).toBeNull();
  });

  it("valores que no son un token se rechazan sin lanzar errores", () => {
    for (const value of [undefined, null, 42, "", "x", "abc.def", "1.2.3", `${OPENED.getTime()}.`, "9".repeat(200), { a: 1 }]) {
      expect(verifyOpenedAt(SECRET, value, later(1000)), String(value)).toBeNull();
    }
  });
});
