import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTables, createDoctor, createPatient, createTestPool, createUser, resetDatabase, type CreatedDoctor } from "../integration/helpers/db.js";
import { anonymousForm, createTestApp, linkTokenSentTo, postForm, type TestApp } from "../integration/helpers/app.js";

const pool = createTestPool();
const DAY = 86_400_000;
let t: TestApp;
let doctor: CreatedDoctor;

beforeAll(async () => {
  await resetDatabase(pool);
  t = await createTestApp(pool);
});

beforeEach(async () => {
  await clearTables(pool);
  await t.services.legal.publish({ type: "reception_privacy", title: "Aviso", body: "x", isProvisional: false });
  await t.services.legal.publish({ type: "reception_confidentiality", title: "Compromiso", body: "x", isProvisional: false });
  doctor = await createDoctor(pool, { fullName: "Dra. Invitadora", email: "dra@example.com" });
});

afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params as never[]);
  return result;
}

/** El médico invita; devuelve el token del enlace recibido por correo. */
async function invitedToken(email: string): Promise<string> {
  await t.services.invitations.invite(doctor.doctorId, doctor.user.id, email);
  return linkTokenSentTo(t, email, "/recepcion/invitacion");
}

const newPerson = {
  fullName: "Laura Recepción",
  password: "una frase larga que se recuerda",
  acceptPrivacy: "yes",
  acceptConfidentiality: "yes",
};

async function accept(token: string, overrides: Record<string, string | undefined> = {}, ip?: string) {
  const { cookie, token: csrf } = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
  const fields: Record<string, string> = { ...newPerson, _csrf: csrf };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[key];
    else fields[key] = value;
  }
  return postForm(t.app, `/recepcion/invitacion/${token}`, fields, cookie, ip);
}

describe("el correo de invitación", () => {
  it("nombra al médico, lleva un enlace de un solo uso y avisa que caduca en 7 días", async () => {
    await t.services.invitations.invite(doctor.doctorId, doctor.user.id, "laura@example.com");
    await t.runOutbox();
    const email = t.transport.sent.find((m) => m.to === "laura@example.com");
    expect(email?.subject).not.toContain("Invitadora");
    expect(email?.text).toContain("Dra. Invitadora");
    expect(email?.text).toContain("7 días");
    expect(email?.text).toMatch(/\/recepcion\/invitacion\/[A-Za-z0-9_-]{43}/);
  });
});

describe("GET /recepcion/invitacion/:token", () => {
  it("muestra el resumen y el formulario sin consumir el token", async () => {
    const token = await invitedToken("laura@example.com");
    for (let i = 0; i < 3; i += 1) {
      const response = await t.app.inject({ method: "GET", url: `/recepcion/invitacion/${token}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Dra. Invitadora");
      expect(response.body).toContain('name="acceptPrivacy"');
      expect(response.body).toContain('name="acceptConfidentiality"');
      expect(response.body).not.toMatch(/\bchecked\b/);
      expect(response.body).toContain('name="password"'); // cuenta nueva
    }
    expect(await rows("SELECT COUNT(*) AS n FROM one_time_token WHERE used_at IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 0 }]);
  });

  it("para una cuenta de recepción ya existente no pide contraseña ni nombre", async () => {
    await createUser(pool, { role: "reception", email: "laura@example.com" });
    const token = await invitedToken("laura@example.com");
    const response = await t.app.inject({ method: "GET", url: `/recepcion/invitacion/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('name="password"');
  });

  it("un token inventado muestra el aviso de enlace vencido", async () => {
    const response = await t.app.inject({ method: "GET", url: `/recepcion/invitacion/${"a".repeat(43)}` });
    expect(response.statusCode).toBe(410);
    expect(response.body).toContain("venció");
  });
});

describe("POST /recepcion/invitacion/:token (persona nueva)", () => {
  it("crea la cuenta, el vínculo, las dos aceptaciones, avisa al médico y abre sesión", async () => {
    const token = await invitedToken("laura@example.com");
    const response = await accept(token);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/recepcion/panel");
    expect(response.cookies.find((c) => c.name === "__Host-sid")).toBeDefined();

    const [user] = await rows("SELECT id, role, full_name, status FROM `user` WHERE email_normalized = 'laura@example.com'");
    expect(user).toMatchObject({ role: "reception", full_name: "Laura Recepción", status: "active" });

    expect(await rows("SELECT doctor_id, reception_user_id, active_flag, revoked_at FROM reception_membership")).toEqual([
      { doctor_id: doctor.doctorId, reception_user_id: user?.id, active_flag: 1, revoked_at: null },
    ]);
    expect(await rows("SELECT status FROM reception_invitation")).toEqual([{ status: "accepted" }]);

    const consents = await rows(
      "SELECT d.type, d.version FROM consent_acceptance c JOIN legal_document d ON d.id = c.legal_document_id WHERE c.user_id = ? ORDER BY CAST(d.type AS CHAR)",
      [user?.id],
    );
    expect(consents).toEqual([
      { type: "reception_confidentiality", version: 1 },
      { type: "reception_privacy", version: 1 },
    ]);

    await t.runOutbox();
    const joined = t.transport.sent.find((m) => m.to === "dra@example.com" && /aceptó|acept/i.test(m.text));
    expect(joined?.text).toContain("laura@example.com");

    const log = await rows("SELECT action FROM reception_action_log ORDER BY id");
    expect(log.map((r) => r.action)).toEqual(["invite", "accept"]);
  });

  it("exige las dos casillas y no consume el token si faltan", async () => {
    const token = await invitedToken("laura@example.com");
    for (const overrides of [{ acceptPrivacy: undefined }, { acceptConfidentiality: undefined }, { acceptPrivacy: "no" }]) {
      const response = await accept(token, overrides);
      expect(response.statusCode).toBe(400);
    }
    expect(await rows("SELECT COUNT(*) AS n FROM `user` WHERE role = 'reception'")).toEqual([{ n: 0 }]);
    expect((await t.app.inject({ method: "GET", url: `/recepcion/invitacion/${token}` })).statusCode).toBe(200);
  });

  it("una cuenta nueva exige nombre y una contraseña que cumpla la política", async () => {
    const token = await invitedToken("laura@example.com");
    for (const overrides of [{ password: undefined }, { password: "corta" }, { password: "1234567890" }, { password: "laura@example.com" }, { fullName: "L" }]) {
      expect((await accept(token, overrides)).statusCode, JSON.stringify(overrides)).toBe(400);
    }
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 0 }]);
    expect((await accept(token)).statusCode).toBe(303);
  });

  it("el token solo sirve una vez", async () => {
    const token = await invitedToken("laura@example.com");
    const firstTab = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
    expect((await accept(token)).statusCode).toBe(303);
    const second = await postForm(
      t.app,
      `/recepcion/invitacion/${token}`,
      { ...newPerson, _csrf: firstTab.token },
      firstTab.cookie,
    );
    expect(second.statusCode).toBe(410);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 1 }]);
  });

  it("a los 7 días la invitación venció", async () => {
    const token = await invitedToken("laura@example.com");
    const form = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
    t.clock.advance(7 * DAY + 1000);
    expect((await t.app.inject({ method: "GET", url: `/recepcion/invitacion/${token}` })).statusCode).toBe(410);
    const response = await postForm(t.app, `/recepcion/invitacion/${token}`, { ...newPerson, _csrf: form.token }, form.cookie);
    expect(response.statusCode).toBe(410);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 0 }]);
  });

  it("una invitación revocada no se puede aceptar aunque el token siga siendo válido", async () => {
    const token = await invitedToken("laura@example.com");
    const form = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
    const [invitation] = await rows("SELECT id FROM reception_invitation");
    await t.services.invitations.revoke(doctor.doctorId, doctor.user.id, Number(invitation?.id));
    const response = await postForm(t.app, `/recepcion/invitacion/${token}`, { ...newPerson, _csrf: form.token }, form.cookie);
    expect(response.statusCode).toBe(410);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 0 }]);
  });

  it("si el correo se registró con otro rol después de invitar, se rechaza con mensaje genérico", async () => {
    const token = await invitedToken("laura@example.com");
    await createPatient(pool, { email: "laura@example.com" });
    const response = await accept(token);
    expect(response.statusCode).toBe(400);
    const mensajes = [...response.body.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]).join(" ");
    expect(mensajes).not.toMatch(/paciente|médico|doctor|soporte/i);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 0 }]);
  });

  it("exige token CSRF", async () => {
    const token = await invitedToken("laura@example.com");
    const response = await postForm(t.app, `/recepcion/invitacion/${token}`, { ...newPerson });
    expect(response.statusCode).toBe(403);
  });

  it("con aceptaciones simultáneas solo se crea un vínculo", async () => {
    const token = await invitedToken("laura@example.com");
    const a = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
    const b = await anonymousForm(t.app, `/recepcion/invitacion/${token}`);
    const results = await Promise.all([
      postForm(t.app, `/recepcion/invitacion/${token}`, { ...newPerson, _csrf: a.token }, a.cookie),
      postForm(t.app, `/recepcion/invitacion/${token}`, { ...newPerson, _csrf: b.token }, b.cookie),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([303, 410]);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM `user` WHERE role = 'reception'")).toEqual([{ n: 1 }]);
  });
});

describe("POST /recepcion/invitacion/:token (cuenta de recepción existente)", () => {
  it("vincula a la persona sin pedir contraseña, sin tocar la suya y sin abrir sesión", async () => {
    const person = await createUser(pool, { role: "reception", email: "laura@example.com" });
    const [before] = await rows("SELECT password_hash FROM `user` WHERE id = ?", [person.id]);
    const token = await invitedToken("laura@example.com");

    const response = await accept(token, { password: undefined, fullName: undefined });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");
    expect(response.cookies.find((c) => c.name === "__Host-sid")).toBeUndefined();

    expect(await rows("SELECT reception_user_id FROM reception_membership")).toEqual([{ reception_user_id: person.id }]);
    const [after] = await rows("SELECT password_hash FROM `user` WHERE id = ?", [person.id]);
    expect(after?.password_hash).toBe(before?.password_hash);
  });

  it("una persona puede trabajar con varios médicos", async () => {
    const otherDoctor = await createDoctor(pool, { fullName: "Dr. Segundo" });
    const person = await createUser(pool, { role: "reception", email: "laura@example.com" });
    await accept(await invitedToken("laura@example.com"), { password: undefined });
    await t.services.invitations.invite(otherDoctor.doctorId, otherDoctor.user.id, "laura@example.com");
    const token2 = await linkTokenSentTo(t, "laura@example.com", "/recepcion/invitacion");
    expect((await accept(token2, { password: undefined })).statusCode).toBe(303);
    expect(await rows("SELECT COUNT(*) AS n FROM reception_membership WHERE reception_user_id = ?", [person.id])).toEqual([{ n: 2 }]);
  });
});
