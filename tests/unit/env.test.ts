import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const base = {
  APP_ENV: "development",
  PUBLIC_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "mysql://app:clave-de-prueba@localhost:3306/boquitas",
  SESSION_SECRET: "a".repeat(32),
  MFA_ENCRYPTION_KEY: "b".repeat(64),
  CEDULA_STORAGE_DIR: "./storage/cedulas",
};

describe("loadEnv", () => {
  it("acepta una configuración mínima de desarrollo y aplica valores por defecto", () => {
    const env = loadEnv(base);
    expect(env.APP_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.PASSWORD_HASHER).toBe("argon2");
    expect(env.SUPPORT_EMAIL).toBe("soporte@innvend.com");
    expect(env.RIGHTS_CONTACT_EMAIL).toBe("soporte@innvend.com");
    expect(env.RIGHTS_RESPONSE_DAYS).toBe(20);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it("LOGO_STORAGE_DIR vale por defecto la carpeta logos dentro de la de cédulas y se puede cambiar", () => {
    expect(loadEnv(base).LOGO_STORAGE_DIR.replace(/\\/g, "/")).toBe("storage/cedulas/logos");
    expect(loadEnv({ ...base, LOGO_STORAGE_DIR: "/var/app/logos" }).LOGO_STORAGE_DIR).toBe("/var/app/logos");
  });

  it("GOOGLE_MAPS_EMBED_KEY es opcional; una clave demasiado corta se rechaza sin mostrar su valor", () => {
    expect(loadEnv(base).GOOGLE_MAPS_EMBED_KEY).toBeUndefined();
    expect(loadEnv({ ...base, GOOGLE_MAPS_EMBED_KEY: "k".repeat(20) }).GOOGLE_MAPS_EMBED_KEY).toBe("k".repeat(20));
    expect(() => loadEnv({ ...base, GOOGLE_MAPS_EMBED_KEY: "corta" })).toThrow("GOOGLE_MAPS_EMBED_KEY");
    let message = "";
    try {
      loadEnv({ ...base, GOOGLE_MAPS_EMBED_KEY: "corta" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("corta");
  });

  it("las claves de Turnstile son opcionales, van en pareja y su valor nunca aparece en el error", () => {
    const site = "s".repeat(20);
    const secret = "x".repeat(24);
    const loaded = loadEnv({ ...base, TURNSTILE_SITE_KEY: site, TURNSTILE_SECRET_KEY: secret });
    expect(loaded.TURNSTILE_SITE_KEY).toBe(site);
    expect(loaded.TURNSTILE_SECRET_KEY).toBe(secret);
    expect(loadEnv(base).TURNSTILE_SITE_KEY).toBeUndefined();
    expect(loadEnv(base).TURNSTILE_SECRET_KEY).toBeUndefined();
    for (const partial of [{ TURNSTILE_SITE_KEY: site }, { TURNSTILE_SECRET_KEY: secret }, { TURNSTILE_SITE_KEY: "corta", TURNSTILE_SECRET_KEY: secret }]) {
      let message = "";
      try {
        loadEnv({ ...base, ...partial });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("TURNSTILE");
      for (const value of [site, secret, "corta"]) expect(message).not.toContain(value);
    }
  });

  it("TRUST_PROXY acepta false, un número de saltos o una lista de IP/CIDR, y nunca true", () => {
    expect(loadEnv({ ...base, TRUST_PROXY: "0" }).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).TRUST_PROXY).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(loadEnv({ ...base, TRUST_PROXY: "::1" }).TRUST_PROXY).toEqual(["::1"]);
    for (const invalido of ["true", "11", "-1", "1.5", "10.0.0.0/33", "no-es-ip", "1/2/3"]) {
      expect(() => loadEnv({ ...base, TRUST_PROXY: invalido }), invalido).toThrow(/TRUST_PROXY/);
    }
  });

  it("devuelve un objeto inmutable", () => {
    const env = loadEnv(base);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("rechaza APP_ENV fuera de development|production", () => {
    expect(() => loadEnv({ ...base, APP_ENV: "staging" })).toThrow(/APP_ENV/);
  });

  it("rechaza un SESSION_SECRET corto", () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: "corto" })).toThrow(/SESSION_SECRET/);
  });

  it("rechaza una MFA_ENCRYPTION_KEY que no sea hexadecimal de 64 caracteres", () => {
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: "zz".repeat(32) })).toThrow(
      /MFA_ENCRYPTION_KEY/,
    );
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: "ab".repeat(16) })).toThrow(
      /MFA_ENCRYPTION_KEY/,
    );
  });

  it("exige SMTP completo en producción", () => {
    expect(() => loadEnv({ ...base, APP_ENV: "production" })).toThrow(/SMTP_HOST/);
    const env = loadEnv({
      ...base,
      APP_ENV: "production",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_USER: "usuario",
      SMTP_PASS: "clave-de-prueba",
      SMTP_FROM: "no-responder@example.com",
      TRUST_PROXY: "0",
    });
    expect(env.SMTP_PORT).toBe(465);
  });

  it("en producción exige definir TRUST_PROXY explícitamente (0 si no hay proxy)", () => {
    const production = {
      ...base,
      APP_ENV: "production",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_USER: "usuario",
      SMTP_PASS: "clave-de-prueba",
      SMTP_FROM: "no-responder@example.com",
    };
    expect(() => loadEnv(production)).toThrow(/TRUST_PROXY/);
    expect(() => loadEnv({ ...production, TRUST_PROXY: "  " })).toThrow(/TRUST_PROXY/);
    expect(loadEnv({ ...production, TRUST_PROXY: "0" }).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...production, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
  });

  it("nunca incluye valores en el mensaje de error", () => {
    const secretoDePrueba = "este-valor-no-debe-aparecer";
    try {
      loadEnv({ ...base, APP_ENV: secretoDePrueba, DATABASE_URL: "no-es-una-url-" + secretoDePrueba });
      throw new Error("debía fallar");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secretoDePrueba);
    }
  });
});
