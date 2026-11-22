import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LegalType } from "../../src/modules/legal/legal-service.js";
import { JPEG, anonymousForm, createTestApp, linkTokenSentTo, postForm, postMultipart, type TestApp } from "./helpers/app.js";
import { clearTables, createDoctor, createTestPool, resetDatabase } from "./helpers/db.js";

const pool = createTestPool();
const SMTP = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "usuario",
  SMTP_PASS: "clave-de-prueba",
  SMTP_FROM: "no-responder@example.com",
  TRUST_PROXY: "0",
};
let production: TestApp;
let development: TestApp;

beforeAll(async () => {
  await resetDatabase(pool);
  production = await createTestApp(pool, { APP_ENV: "production", ...SMTP });
  development = await createTestApp(pool, { APP_ENV: "development" });
});

beforeEach(async () => {
  await clearTables(pool);
});

afterAll(async () => {
  await production.app.close();
  await development.app.close();
  await pool.end();
});

async function publish(t: TestApp, type: LegalType, isProvisional: boolean): Promise<void> {
  await t.services.legal.publish({ type, title: type, body: `Texto de ${type}.`, isProvisional });
}

async function publishAll(t: TestApp, provisional: LegalType[] = []): Promise<void> {
  for (const type of ["patient_privacy", "doctor_privacy", "terms_doctor", "reception_privacy", "reception_confidentiality"] as LegalType[]) {
    await publish(t, type, provisional.includes(type));
  }
}

async function count(table: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0]?.n);
}

async function registerPatient(t: TestApp) {
  const { cookie, token } = await anonymousForm(t.app, "/pacientes/registro");
  return postForm(
    t.app,
    "/pacientes/registro",
    { fullName: "Ana Pérez", birthDate: "1990-05-17", email: "ana@example.com", phone: "5512345678", password: "una frase larga que se recuerda", acceptPrivacy: "yes", _csrf: token },
    cookie,
  );
}

async function registerDoctor(t: TestApp) {
  const { cookie, token } = await anonymousForm(t.app, "/medicos/registro");
  return postMultipart(
    t.app,
    "/medicos/registro",
    { fullName: "Dra. Fernanda Gutiérrez", email: "fernanda@example.com", password: "una frase larga que se recuerda", cedulaNumber: "1234567", emergencyMobile: "5512345678", acceptPrivacy: "yes", acceptTerms: "yes", _csrf: token },
    [{ field: "cedulaFile", filename: "c.jpg", content: JPEG, contentType: "image/jpeg" }],
    cookie,
  );
}

async function acceptInvitation(t: TestApp) {
  const doctor = await createDoctor(pool);
  await t.services.invitations.invite(doctor.doctorId, doctor.user.id, "laura@example.com");
  const link = await linkTokenSentTo(t, "laura@example.com", "/recepcion/invitacion");
  const { cookie, token } = await anonymousForm(t.app, `/recepcion/invitacion/${link}`);
  return postForm(
    t.app,
    `/recepcion/invitacion/${link}`,
    { fullName: "Laura Recepción", password: "una frase larga que se recuerda", acceptPrivacy: "yes", acceptConfidentiality: "yes", _csrf: token },
    cookie,
  );
}

describe("pacientes", () => {
  it("en producción con el aviso provisional el alta devuelve 403 y no crea nada", async () => {
    await publishAll(production, ["patient_privacy"]);
    const response = await registerPatient(production);
    expect(response.statusCode).toBe(403);
    expect(await count("user")).toBe(0);
    expect(await count("patient")).toBe(0);
    expect(await count("consent_acceptance")).toBe(0);
  });

  it("en producción con el aviso revisado el alta se permite", async () => {
    await publishAll(production);
    expect((await registerPatient(production)).statusCode).toBe(303);
  });

  it("en desarrollo con el aviso provisional el alta se permite", async () => {
    await publishAll(development, ["patient_privacy"]);
    expect((await registerPatient(development)).statusCode).toBe(303);
  });

  it("al publicar una versión revisada, el alta vuelve a permitirse", async () => {
    await publishAll(production, ["patient_privacy"]);
    expect((await registerPatient(production)).statusCode).toBe(403);
    await publish(production, "patient_privacy", false);
    expect((await registerPatient(production)).statusCode).toBe(303);
  });

  it("un documento provisional de otro rol no bloquea el alta de pacientes", async () => {
    await publishAll(production, ["doctor_privacy", "terms_doctor", "reception_privacy"]);
    expect((await registerPatient(production)).statusCode).toBe(303);
  });
});

describe("médicos", () => {
  it("en producción, cualquiera de sus dos documentos provisionales bloquea el registro (403)", async () => {
    for (const provisional of [["doctor_privacy"], ["terms_doctor"], ["doctor_privacy", "terms_doctor"]] as LegalType[][]) {
      await clearTables(pool);
      await publishAll(production, provisional);
      const response = await registerDoctor(production);
      expect(response.statusCode, provisional.join()).toBe(403);
      expect(await count("doctor")).toBe(0);
      expect(await count("user")).toBe(0);
    }
  });

  it("en producción con ambos revisados el registro se permite; en desarrollo también con provisionales", async () => {
    await publishAll(production);
    expect((await registerDoctor(production)).statusCode).toBe(303);
    await clearTables(pool);
    await publishAll(development, ["doctor_privacy", "terms_doctor"]);
    expect((await registerDoctor(development)).statusCode).toBe(303);
  });
});

describe("recepción", () => {
  it("en producción con los avisos provisionales no se puede aceptar una invitación (403)", async () => {
    for (const provisional of [["reception_privacy"], ["reception_confidentiality"]] as LegalType[][]) {
      await clearTables(pool);
      await publishAll(production, provisional);
      const response = await acceptInvitation(production);
      expect(response.statusCode, provisional.join()).toBe(403);
      expect(await count("reception_membership")).toBe(0);
      const [receptionUsers] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM `user` WHERE role = 'reception'");
      expect(Number(receptionUsers[0]?.n)).toBe(0);
    }
  });

  it("con los avisos revisados la invitación se acepta; en desarrollo también con provisionales", async () => {
    await publishAll(production);
    expect((await acceptInvitation(production)).statusCode).toBe(303);
    await clearTables(pool);
    await publishAll(development, ["reception_privacy", "reception_confidentiality"]);
    expect((await acceptInvitation(development)).statusCode).toBe(303);
  });

  it("la invitación no se consumió: tras revisar los textos se puede aceptar con el mismo enlace", async () => {
    await publishAll(production, ["reception_privacy"]);
    const doctor = await createDoctor(pool);
    await production.services.invitations.invite(doctor.doctorId, doctor.user.id, "laura@example.com");
    const link = await linkTokenSentTo(production, "laura@example.com", "/recepcion/invitacion");
    const accept = async () => {
      const { cookie, token } = await anonymousForm(production.app, `/recepcion/invitacion/${link}`);
      return postForm(
        production.app,
        `/recepcion/invitacion/${link}`,
        { fullName: "Laura", password: "una frase larga que se recuerda", acceptPrivacy: "yes", acceptConfidentiality: "yes", _csrf: token },
        cookie,
      );
    };
    expect((await accept()).statusCode).toBe(403);
    await publish(production, "reception_privacy", false);
    expect((await accept()).statusCode).toBe(303);
  });
});
