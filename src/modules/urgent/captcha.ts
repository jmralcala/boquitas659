/**
 * Verificación anti-bots del paso de urgencia (constitución IV). Cloudflare Turnstile se verifica con el `fetch` de Node
 * (sin dependencias nuevas). El proveedor solo recibe el token y la IP del visitante: nunca la categoría ni datos del paciente.
 *
 * El resultado `unavailable` (el proveedor no responde o la configuración es incorrecta) **cierra** el flujo: no se agenda
 * ni se cuenta nada y se muestra el móvil de emergencias del médico. No es culpa del paciente, así que no es `invalid`.
 */
export type CaptchaResult = "ok" | "invalid" | "unavailable";

export interface CaptchaVerifier {
  verify(token: string, ip: string): Promise<CaptchaResult>;
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Longitud máxima de un token de Turnstile según el proveedor. */
export const MAX_CAPTCHA_TOKEN_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Motivo de un fallo del proveedor, para el registro técnico: nunca el mensaje, el token ni el secreto. */
export type CaptchaFailure = "network" | "timeout" | "bad_status" | "bad_body" | "provider_error";

export interface TurnstileOptions {
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (event: { component: "captcha"; failure: CaptchaFailure }) => void;
}

/** Códigos que indican un problema del proveedor o de nuestra configuración (no del paciente). */
const PROVIDER_ERROR_CODES = new Set(["internal-error", "invalid-input-secret", "missing-input-secret"]);

export function createTurnstileVerifier(options: TurnstileOptions): CaptchaVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fail = (failure: CaptchaFailure): CaptchaResult => {
    options.log?.({ component: "captcha", failure });
    return "unavailable";
  };

  return {
    async verify(token, ip) {
      if (token === "" || token.length > MAX_CAPTCHA_TOKEN_LENGTH) return "invalid";

      const body = new URLSearchParams({ secret: options.secret, response: token });
      if (ip !== "") body.set("remoteip", ip);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(TURNSTILE_VERIFY_URL, {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          signal: controller.signal,
        });
        if (response.status !== 200) return fail("bad_status");
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          return fail("bad_body");
        }
        if (typeof parsed !== "object" || parsed === null) return fail("bad_body");
        const { success, "error-codes": codes } = parsed as { success?: unknown; "error-codes"?: unknown };
        if (typeof success !== "boolean") return fail("bad_body");
        if (success) return "ok";
        if (Array.isArray(codes) && codes.some((code) => typeof code === "string" && PROVIDER_ERROR_CODES.has(code))) return fail("provider_error");
        return "invalid";
      } catch (error) {
        // Solo el tipo de fallo: el mensaje puede incluir el secreto o el token.
        return fail((error as { name?: string }).name === "AbortError" ? "timeout" : "network");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Desarrollo sin claves: el paso del CAPTCHA se omite. */
export function createDisabledVerifier(): CaptchaVerifier {
  return { verify: () => Promise.resolve("ok") };
}

/** Producción sin claves: la verificación nunca está disponible (la urgencia ni siquiera se ofrece). */
export function createUnavailableVerifier(): CaptchaVerifier {
  return { verify: () => Promise.resolve("unavailable") };
}
