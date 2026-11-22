import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPasswordHasher } from "../../src/modules/auth/password-hasher.js";
import { createSupportUser } from "../../src/modules/support/create-support-user.js";
import { clearTables, createTestPool, createUser, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const hasher = createPasswordHasher("argon2", { argon2: { memoryCost: 1024, timeCost: 2, parallelism: 1 } });

beforeAll(async () => {
  await resetDatabase(pool);
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("createSupportUser", () => {
  it("crea un usuario de soporte activo con el correo normalizado y la contraseña hasheada", async () => {
    const id = await createSupportUser(pool, hasher, {
      email: "  Soporte.Uno@Example.COM ",
      password: "una frase larga y segura para soporte",
    });
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM `user` WHERE id = ?", [id]);
    expect(rows[0]).toMatchObject({
      role: "support",
      status: "active",
      email_normalized: "soporte.uno@example.com",
      mfa_enabled: 0,
    });
    expect(String(rows[0]?.password_hash)).toMatch(/^\$argon2id\$/);
    expect(String(rows[0]?.password_hash)).not.toContain("una frase larga");
    expect(await hasher.verify(String(rows[0]?.password_hash), "una frase larga y segura para soporte")).toBe(true);
  });

  it("rechaza contraseñas débiles o iguales al correo", async () => {
    await expect(createSupportUser(pool, hasher, { email: "s@example.com", password: "corta" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createSupportUser(pool, hasher, { email: "s@example.com", password: "1234567890" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createSupportUser(pool, hasher, { email: "soporte@example.com", password: "soporte@example.com" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rechaza correos inválidos y correos que ya existen con cualquier rol", async () => {
    await expect(
      createSupportUser(pool, hasher, { email: "no-es-correo", password: "una frase larga y segura para soporte" }),
    ).rejects.toMatchObject({ status: 400 });

    await createUser(pool, { role: "patient", email: "ocupado@example.com" });
    await expect(
      createSupportUser(pool, hasher, { email: "OCUPADO@example.com", password: "una frase larga y segura para soporte" }),
    ).rejects.toMatchObject({ status: 400 });
    const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM `user`");
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
