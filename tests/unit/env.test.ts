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
    expect(loadEnv({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
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
    });
    expect(env.SMTP_PORT).toBe(465);
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
