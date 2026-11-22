import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, resetDatabase } from "../integration/helpers/db.js";
import { createTestApp, postForm, sessionFor, type AuthedClient, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
let t: TestApp;
let tutor: { client: AuthedClient; userId: number; accountId: number };

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await t.services.legal.publish({ type: "patient_privacy", title: "Aviso", body: "x", isProvisional: false });
  const created = await createPatient(pool, { fullName: "Tutora Prueba", birthDate: "1985-03-10" });
  tutor = { client: await sessionFor(t.services, created.user), userId: created.user.id, accountId: created.accountId };
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

const child = { fullName: "Mateo Pérez", birthDate: "2018-09-01", phone: "55 8765 4321", acceptPrivacyOnBehalf: "yes" };

function addDependent(client: AuthedClient, overrides: Record<string, string | undefined> = {}) {
  const fields: Record<string, string> = { ...child, _csrf: client.csrf };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[key];
    else fields[key] = value;
  }
  return postForm(t.app, "/pacientes/adicionales", fields, client.cookie);
}

async function count(table: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0]?.n);
}

describe("POST /pacientes/adicionales", () => {
  it("el tutor añade un menor: queda bajo su cuenta, con su propia aceptación en nombre del menor", async () => {
    const response = await addDependent(tutor.client);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/pacientes/panel");

    const [children] = await pool.query<RowDataPacket[]>(
      "SELECT id, account_id, full_name, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date, phone, is_minor_dependent FROM patient WHERE is_minor_dependent = 1",
    );
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      account_id: tutor.accountId,
      full_name: "Mateo Pérez",
      birth_date: "2018-09-01",
      phone: "5587654321",
      is_minor_dependent: 1,
    });

    const [consents] = await pool.query<RowDataPacket[]>(
      "SELECT user_id, on_behalf_of_patient_id FROM consent_acceptance WHERE on_behalf_of_patient_id IS NOT NULL",
    );
    expect(consents).toEqual([{ user_id: tutor.userId, on_behalf_of_patient_id: children[0]?.id }]);
  });

  it("sin marcar la casilla en nombre del menor devuelve 400 y no crea nada", async () => {
    for (const overrides of [{ acceptPrivacyOnBehalf: undefined }, { acceptPrivacyOnBehalf: "no" }]) {
      const response = await addDependent(tutor.client, overrides);
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("aviso de privacidad");
    }
    expect(await count("patient")).toBe(1);
    const [onBehalf] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM consent_acceptance WHERE on_behalf_of_patient_id IS NOT NULL");
    expect(Number(onBehalf[0]?.n)).toBe(0);
  });

  it("valida nombre y fecha de nacimiento", async () => {
    for (const overrides of [{ fullName: "A" }, { birthDate: "2999-01-01" }, { birthDate: "2018-02-30" }, { phone: "12" }]) {
      expect((await addDependent(tutor.client, overrides)).statusCode, JSON.stringify(overrides)).toBe(400);
    }
    expect(await count("patient")).toBe(1);
  });

  it("el teléfono del menor es opcional", async () => {
    expect((await addDependent(tutor.client, { phone: "" })).statusCode).toBe(303);
  });

  it("siempre crea el menor bajo la cuenta de quien tiene la sesión, no bajo la de otra persona", async () => {
    const other = await createPatient(pool, { fullName: "Otra Tutora" });
    const otherClient = await sessionFor(t.services, other.user);
    await addDependent(otherClient, { fullName: "Hija de la otra" });

    const [rows] = await pool.query<RowDataPacket[]>("SELECT account_id FROM patient WHERE full_name = 'Hija de la otra'");
    expect(rows).toEqual([{ account_id: other.accountId }]);
    const [mine] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM patient WHERE account_id = ?", [tutor.accountId]);
    expect(Number(mine[0]?.n)).toBe(1);
  });

  it("solo los pacientes pueden usarla: sin sesión 401, médico 403", async () => {
    const anonymous = await postForm(t.app, "/pacientes/adicionales", { ...child });
    expect([401, 403]).toContain(anonymous.statusCode);

    const doctor = await createDoctor(pool);
    const doctorClient = await sessionFor(t.services, doctor.user);
    expect((await addDependent(doctorClient)).statusCode).toBe(403);
    expect(await count("patient")).toBe(1);
  });

  it("exige token CSRF", async () => {
    const response = await postForm(t.app, "/pacientes/adicionales", { ...child }, tutor.client.cookie);
    expect(response.statusCode).toBe(403);
    expect(await count("patient")).toBe(1);
  });
});

describe("GET /pacientes/panel", () => {
  it("lista al paciente propio y a los adicionales con su edad calculada", async () => {
    await addDependent(tutor.client);
    const response = await t.app.inject({ method: "GET", url: "/pacientes/panel", headers: { cookie: tutor.client.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Tutora Prueba");
    expect(response.body).toContain("Mateo Pérez");
    expect(response.body).toMatch(/Mateo Pérez[\s\S]*?\d+ años/);
    expect(response.body).toContain('name="acceptPrivacyOnBehalf"');
    expect(response.body).not.toMatch(/\bchecked\b/);
  });

  it("no muestra a los pacientes de otra cuenta", async () => {
    await createPatient(pool, { fullName: "Persona Ajena" });
    const response = await t.app.inject({ method: "GET", url: "/pacientes/panel", headers: { cookie: tutor.client.cookie } });
    expect(response.body).not.toContain("Persona Ajena");
  });

  it("exige rol de paciente", async () => {
    const doctor = await createDoctor(pool);
    const doctorClient = await sessionFor(t.services, doctor.user);
    const response = await t.app.inject({ method: "GET", url: "/pacientes/panel", headers: { cookie: doctorClient.cookie, accept: "application/json" } });
    expect(response.statusCode).toBe(403);
  });
});
