import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createTestPool, createUser, resetDatabase } from "../integration/helpers/db.js";
import {
  JPEG,
  PDF,
  anonymousForm,
  createTestApp,
  postMultipart,
  type TestApp,
} from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await t.services.legal.publish({ type: "doctor_privacy", title: "Aviso", body: "x", isProvisional: false });
  await t.services.legal.publish({ type: "terms_doctor", title: "Términos", body: "x", isProvisional: false });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const valid = {
  fullName: "Dra. Fernanda Gutiérrez",
  email: "fernanda@example.com",
  password: "una frase larga que se recuerda",
  cedulaNumber: "1234567",
  emergencyMobile: "55 1234 5678",
  officePhone: "55 8765 4321",
  acceptPrivacy: "yes",
  acceptTerms: "yes",
};

async function register(overrides: Record<string, string | undefined> = {}, file = true) {
  const { cookie, token } = await anonymousForm(t.app, "/medicos/registro");
  const fields: Record<string, string> = { ...valid, _csrf: token };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[key];
    else fields[key] = value;
  }
  return postMultipart(
    t.app,
    "/medicos/registro",
    fields,
    file ? [{ field: "cedulaFile", filename: "cedula.jpg", content: JPEG, contentType: "image/jpeg" }] : [],
    cookie,
  );
}

async function count(table: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0]?.n);
}

describe("GET /medicos/registro", () => {
  it("muestra el formulario con las casillas sin marcar", async () => {
    const response = await t.app.inject({ method: "GET", url: "/medicos/registro" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="acceptPrivacy"');
    expect(response.body).toContain('name="acceptTerms"');
    expect(response.body).not.toMatch(/\bchecked\b/);
    expect(response.body).toContain('enctype="multipart/form-data"');
  });
});

describe("POST /medicos/registro", () => {
  it("con todo válido crea la cuenta pendiente, registra dos aceptaciones y avisa a soporte", async () => {
    const response = await register();
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/medicos/estado");
    expect(response.cookies.find((c) => c.name === "__Host-sid")).toBeDefined();

    const [doctors] = await pool.query<RowDataPacket[]>(
      "SELECT d.*, u.email, u.role FROM doctor d JOIN `user` u ON u.id = d.user_id",
    );
    expect(doctors).toHaveLength(1);
    expect(doctors[0]).toMatchObject({
      approval_status: "pending",
      role: "doctor",
      email: "fernanda@example.com",
      cedula_normalized: "1234567",
      emergency_mobile: "5512345678",
      office_phone: "5587654321",
    });
    expect(doctors[0]?.cedula_file_path).toMatch(/^[a-f0-9]{32}\.jpg$/);

    const [consents] = await pool.query<RowDataPacket[]>(
      "SELECT d.type, d.version FROM consent_acceptance c JOIN legal_document d ON d.id = c.legal_document_id ORDER BY d.type",
    );
    expect(consents).toEqual([
      { type: "doctor_privacy", version: 1 },
      { type: "terms_doctor", version: 1 },
    ]);

    await t.runOutbox();
    expect(t.transport.sent).toHaveLength(1);
    const email = t.transport.sent[0];
    expect(email?.to).toBe("soporte@innvend.com");
    expect(email?.text).toMatch(/\/soporte\/medicos\/\d+/);
    expect(email?.text).not.toContain("Fernanda");
    expect(email?.text).not.toContain("1234567");
  });

  it("sin las dos casillas marcadas devuelve 400 y no crea nada", async () => {
    for (const missing of [{ acceptPrivacy: undefined }, { acceptTerms: undefined }, { acceptPrivacy: "no" }]) {
      const response = await register(missing);
      expect(response.statusCode).toBe(400);
    }
    const response = await register({ acceptPrivacy: undefined, acceptTerms: undefined });
    expect(response.body).toContain("aviso de privacidad");
    expect(await count("user")).toBe(0);
    expect(await count("doctor")).toBe(0);
    expect(await count("consent_acceptance")).toBe(0);
  });

  it("sin archivo de cédula devuelve 400", async () => {
    const response = await register({}, false);
    expect(response.statusCode).toBe(400);
    expect(await count("doctor")).toBe(0);
  });

  it("rechaza un archivo que no es JPEG, PNG ni PDF aunque diga serlo", async () => {
    const { cookie, token } = await anonymousForm(t.app, "/medicos/registro");
    const response = await postMultipart(
      t.app,
      "/medicos/registro",
      { ...valid, _csrf: token },
      [{ field: "cedulaFile", filename: "cedula.jpg", content: Buffer.from("<script>alert(1)</script>"), contentType: "image/jpeg" }],
      cookie,
    );
    expect(response.statusCode).toBe(400);
    expect(await count("doctor")).toBe(0);
  });

  it("acepta PDF", async () => {
    const { cookie, token } = await anonymousForm(t.app, "/medicos/registro");
    const response = await postMultipart(
      t.app,
      "/medicos/registro",
      { ...valid, _csrf: token },
      [{ field: "cedulaFile", filename: "cedula.pdf", content: PDF, contentType: "application/pdf" }],
      cookie,
    );
    expect(response.statusCode).toBe(303);
  });

  it("un archivo de más de 5 MB devuelve 413", async () => {
    const { cookie, token } = await anonymousForm(t.app, "/medicos/registro");
    const response = await postMultipart(
      t.app,
      "/medicos/registro",
      { ...valid, _csrf: token },
      [{ field: "cedulaFile", filename: "cedula.jpg", content: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), contentType: "image/jpeg" }],
      cookie,
    );
    expect(response.statusCode).toBe(413);
    expect(await count("doctor")).toBe(0);
  });

  it("cédula duplicada: 400 con mensaje que remite a soporte y sin cuenta nueva", async () => {
    expect((await register()).statusCode).toBe(303);
    const response = await register({ email: "otra@example.com", emergencyMobile: "55 9999 0000" });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("soporte");
    expect(await count("user")).toBe(1);
    expect(await count("doctor")).toBe(1);
  });

  it("móvil de emergencias duplicado: 400 con mensaje que remite a soporte", async () => {
    expect((await register()).statusCode).toBe(303);
    const response = await register({ email: "otra@example.com", cedulaNumber: "7654321" });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("soporte");
    expect(await count("doctor")).toBe(1);
  });

  it("móvil con formato inválido: 400", async () => {
    for (const emergencyMobile of ["123", "abcdefghij", "05512345678", "1512345678"]) {
      const response = await register({ emergencyMobile });
      expect(response.statusCode, emergencyMobile).toBe(400);
    }
    expect(await count("doctor")).toBe(0);
  });

  it("un correo ya registrado con otro rol se rechaza con mensaje genérico que no revela el rol", async () => {
    await createUser(pool, { role: "patient", email: "fernanda@example.com" });
    const response = await register();
    expect(response.statusCode).toBe(400);
    const mensajes = [...response.body.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]).join(" ");
    expect(mensajes).toContain("No pudimos usar ese correo");
    expect(mensajes).not.toMatch(/paciente|patient|recepci|soporte|rol/i);
    expect(await count("doctor")).toBe(0);
  });

  it("rechaza contraseñas débiles y la igual al correo", async () => {
    expect((await register({ password: "corta" })).statusCode).toBe(400);
    expect((await register({ password: "1234567890" })).statusCode).toBe(400);
    expect((await register({ password: "fernanda@example.com" })).statusCode).toBe(400);
    expect(await count("user")).toBe(0);
  });

  it("al fallar por duplicado no deja archivos huérfanos en el almacén", async () => {
    expect((await register()).statusCode).toBe(303);
    const { readdirSync } = await import("node:fs");
    const antes = readdirSync(t.services.env.CEDULA_STORAGE_DIR).length;
    await register({ email: "otra@example.com", emergencyMobile: "55 9999 0000" });
    expect(readdirSync(t.services.env.CEDULA_STORAGE_DIR).length).toBe(antes);
  });

  it("exige token CSRF", async () => {
    const response = await postMultipart(t.app, "/medicos/registro", { ...valid }, [
      { field: "cedulaFile", filename: "c.jpg", content: JPEG, contentType: "image/jpeg" },
    ]);
    expect(response.statusCode).toBe(403);
    expect(await count("user")).toBe(0);
  });
});
