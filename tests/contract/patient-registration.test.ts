import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import { anonymousForm, createTestApp, postForm, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await t.services.legal.publish({ type: "patient_privacy", title: "Aviso", body: "x", isProvisional: false });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const valid = {
  fullName: "Ana Pérez López",
  birthDate: "1990-05-17",
  email: "ana.perez@example.com",
  phone: "55 1234 5678",
  password: "una frase larga que se recuerda",
  acceptPrivacy: "yes",
};

async function register(overrides: Record<string, string | undefined> = {}, ip?: string) {
  const { cookie, token } = await anonymousForm(t.app, "/pacientes/registro");
  const fields: Record<string, string> = { ...valid, _csrf: token };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[key];
    else fields[key] = value;
  }
  return postForm(t.app, "/pacientes/registro", fields, cookie, ip);
}

async function count(table: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0]?.n);
}

describe("GET /pacientes/registro", () => {
  it("muestra el formulario con la casilla del aviso sin marcar", async () => {
    const response = await t.app.inject({ method: "GET", url: "/pacientes/registro" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="acceptPrivacy"');
    expect(response.body).not.toMatch(/\bchecked\b/);
    expect(response.body).toContain("datos personales y de salud");
  });
});

describe("POST /pacientes/registro", () => {
  it("crea cuenta, paciente y aceptación (quién, documento, versión, cuándo) y abre sesión", async () => {
    const response = await register();
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pacientes/panel");
    expect(response.cookies.find((c) => c.name === "__Host-sid")).toBeDefined();

    const [patients] = await pool.query<RowDataPacket[]>(
      `SELECT p.full_name, DATE_FORMAT(p.birth_date, '%Y-%m-%d') AS birth_date, p.email, p.phone, p.is_minor_dependent,
              a.phone AS account_phone, u.role, u.email AS user_email
         FROM patient p JOIN patient_account a ON a.id = p.account_id JOIN \`user\` u ON u.id = a.user_id`,
    );
    expect(patients).toEqual([
      {
        full_name: "Ana Pérez López",
        birth_date: "1990-05-17",
        email: "ana.perez@example.com",
        phone: "5512345678",
        is_minor_dependent: 0,
        account_phone: "5512345678",
        role: "patient",
        user_email: "ana.perez@example.com",
      },
    ]);

    const [consents] = await pool.query<RowDataPacket[]>(
      `SELECT c.user_id, c.on_behalf_of_patient_id, d.type, d.version, c.accepted_at
         FROM consent_acceptance c JOIN legal_document d ON d.id = c.legal_document_id`,
    );
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ type: "patient_privacy", version: 1, on_behalf_of_patient_id: null });
    expect(consents[0]?.accepted_at).toBeInstanceOf(Date);
  });

  it("no guarda la edad: la tabla de pacientes solo tiene fecha de nacimiento", async () => {
    const [columns] = await pool.query<RowDataPacket[]>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'patient'",
    );
    const names = columns.map((c) => String(c.name));
    expect(names).toContain("birth_date");
    expect(names.some((n) => /^age$|edad/i.test(n))).toBe(false);
  });

  it("sin la casilla del aviso devuelve 400 y no crea nada", async () => {
    for (const overrides of [{ acceptPrivacy: undefined }, { acceptPrivacy: "no" }]) {
      const response = await register(overrides);
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("aviso de privacidad");
    }
    expect(await count("user")).toBe(0);
    expect(await count("patient")).toBe(0);
    expect(await count("consent_acceptance")).toBe(0);
  });

  it("un correo ya registrado indica iniciar sesión, sin importar el rol de la cuenta existente", async () => {
    expect((await register()).statusCode).toBe(303);
    const again = await register();
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("inicia sesión");

    await createDoctor(pool, { email: "medico@example.com" });
    const other = await register({ email: "medico@example.com" });
    expect(other.statusCode).toBe(400);
    const mensajes = [...other.body.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]).join(" ");
    expect(mensajes).toContain("inicia sesión");
    expect(mensajes).not.toMatch(/médico|doctor|soporte|recepci/i);
    expect(await count("patient")).toBe(1);
  });

  it("limita las peticiones por IP: la número 11 en una hora recibe 429", async () => {
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await register({ password: "corta" }, ip)).statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("valida fecha de nacimiento, teléfono y contraseña", async () => {
    for (const overrides of [
      { birthDate: "2999-01-01" },
      { birthDate: "2026-02-30" },
      { birthDate: "17/05/1990" },
      { phone: "123" },
      { password: "corta" },
      { password: "1234567890" },
      { password: "ana.perez@example.com" },
      { email: "no-es-correo" },
      { fullName: "A" },
    ]) {
      const response = await register(overrides);
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
    }
    expect(await count("user")).toBe(0);
  });

  it("exige token CSRF", async () => {
    const response = await postForm(t.app, "/pacientes/registro", { ...valid });
    expect(response.statusCode).toBe(403);
    expect(await count("user")).toBe(0);
  });

  it("el correo duplicado se compara normalizado (mayúsculas y espacios)", async () => {
    await createUser(pool, { role: "patient", email: "ana.perez@example.com" });
    const response = await register({ email: "  ANA.PEREZ@Example.com " });
    expect(response.statusCode).toBe(400);
  });
});
