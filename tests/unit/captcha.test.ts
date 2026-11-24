import { describe, expect, it } from "vitest";
import {
  MAX_CAPTCHA_TOKEN_LENGTH,
  TURNSTILE_VERIFY_URL,
  createDisabledVerifier,
  createTurnstileVerifier,
  createUnavailableVerifier,
} from "../../src/modules/urgent/captcha.js";

const SECRET = "secreto-de-turnstile-muy-reconocible";
const TOKEN = "token-del-paciente-reconocible";

interface Call {
  url: string;
  body: URLSearchParams;
}

function stub(respond: () => Promise<Response> | Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createTurnstileVerifier", () => {
  it("success: true → ok; manda solo secret, response y remoteip a la dirección del proveedor", async () => {
    const { fetchImpl, calls } = stub(() => json({ success: true }));
    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl });
    expect(await verifier.verify(TOKEN, "203.0.113.9")).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect([...(calls[0]?.body.keys() ?? [])].sort()).toEqual(["remoteip", "response", "secret"]);
    expect(calls[0]?.body.get("secret")).toBe(SECRET);
    expect(calls[0]?.body.get("response")).toBe(TOKEN);
    expect(calls[0]?.body.get("remoteip")).toBe("203.0.113.9");
  });

  it("success: false (token inválido, vencido o ya usado) → invalid", async () => {
    for (const codes of [["invalid-input-response"], ["timeout-or-duplicate"], ["missing-input-response"]]) {
      const { fetchImpl } = stub(() => json({ success: false, "error-codes": codes }));
      expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl }).verify(TOKEN, "203.0.113.9")).toBe("invalid");
    }
  });

  it("un token vacío o de más de 2048 caracteres es invalid SIN llamar al proveedor", async () => {
    const { fetchImpl, calls } = stub(() => json({ success: true }));
    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl });
    expect(await verifier.verify("", "203.0.113.9")).toBe("invalid");
    expect(await verifier.verify("a".repeat(MAX_CAPTCHA_TOKEN_LENGTH + 1), "203.0.113.9")).toBe("invalid");
    expect(await verifier.verify("a".repeat(MAX_CAPTCHA_TOKEN_LENGTH), "203.0.113.9")).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("un fallo del proveedor o de la configuración es unavailable (no culpa al paciente)", async () => {
    const cases: (() => Promise<Response> | Response)[] = [
      () => Promise.reject(new Error("sin red")),
      () => json({ success: false, "error-codes": ["internal-error"] }),
      () => json({ success: false, "error-codes": ["invalid-input-secret"] }),
      () => json({ success: false, "error-codes": ["missing-input-secret"] }),
      () => json({}, 500),
      () => json({ success: true }, 503),
      () => new Response("<html>no es json</html>", { status: 200 }),
      () => json({ otra: "cosa" }),
      () => json({ success: "si" }),
      () => json(null),
    ];
    for (const respond of cases) {
      const { fetchImpl } = stub(respond);
      expect(await createTurnstileVerifier({ secret: SECRET, fetchImpl }).verify(TOKEN, "203.0.113.9")).toBe("unavailable");
    }
  });

  it("pasado el tiempo de espera es unavailable y no reintenta", async () => {
    const calls: number[] = [];
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(1);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("agotado", "AbortError")));
      });
    }) as typeof fetch;
    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl, timeoutMs: 20 });
    expect(await verifier.verify(TOKEN, "203.0.113.9")).toBe("unavailable");
    expect(calls).toHaveLength(1);
  });

  it("el secreto y el token nunca aparecen en lo que se registra", async () => {
    const logged: string[] = [];
    const { fetchImpl } = stub(() => Promise.reject(new Error(`falló con ${SECRET} y ${TOKEN}`)));
    const verifier = createTurnstileVerifier({ secret: SECRET, fetchImpl, log: (event) => logged.push(JSON.stringify(event)) });
    expect(await verifier.verify(TOKEN, "203.0.113.9")).toBe("unavailable");
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("203.0.113.9");
    }
  });

  it("la IP vacía no se manda como remoteip", async () => {
    const { fetchImpl, calls } = stub(() => json({ success: true }));
    await createTurnstileVerifier({ secret: SECRET, fetchImpl }).verify(TOKEN, "");
    expect(calls[0]?.body.has("remoteip")).toBe(false);
  });
});

describe("verificadores de desarrollo y de respaldo", () => {
  it("el desactivado (desarrollo sin claves) siempre responde ok", async () => {
    expect(await createDisabledVerifier().verify("", "")).toBe("ok");
    expect(await createDisabledVerifier().verify("lo-que-sea", "203.0.113.9")).toBe("ok");
  });

  it("el no disponible (producción sin claves) siempre responde unavailable", async () => {
    expect(await createUnavailableVerifier().verify(TOKEN, "203.0.113.9")).toBe("unavailable");
  });
});
