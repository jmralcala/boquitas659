import { describe, expect, it } from "vitest";
import { defaultTemplates } from "../../src/mail/templates.js";
import type { Db } from "../../src/db/pool.js";

const baseUrl = "https://agenda.example.com";
const db = {} as unknown as Db;
const NAMES = ["doctor_account_suspended", "doctor_account_read_only", "doctor_account_reactivated", "doctor_site_slug_changed"] as const;

async function render(name: (typeof NAMES)[number], payload: Record<string, string | number | null> = { doctorId: 1, slug: "clinica-nueva" }) {
  const template = defaultTemplates[name];
  if (!template) throw new Error(`Falta la plantilla ${name}.`);
  return template.render({ payload, link: null, baseUrl, db, now: new Date("2026-11-24T12:00:00.000Z") });
}

describe("correos de estado de cuenta de soporte", () => {
  it("las cuatro plantillas están registradas, sin claves sensibles ni reemplazo", () => {
    for (const name of NAMES) {
      const template = defaultTemplates[name];
      expect(template, name).toBeDefined();
      expect(template?.sensitiveKeys, name).toBeUndefined();
      expect(template?.fallbackTemplate, name).toBeUndefined();
    }
  });

  it("nunca incluyen el motivo interno, aunque viaje en el payload", async () => {
    const secret = "MOTIVO-INTERNO-NO-MOSTRAR";
    for (const name of NAMES) {
      const email = await render(name, { doctorId: 1, slug: "clinica-nueva", reason: secret });
      expect(email.subject, name).not.toContain(secret);
      expect(email.text, name).not.toContain(secret);
    }
  });

  it("los asuntos no llevan datos personales", async () => {
    for (const name of NAMES) {
      const { subject } = await render(name);
      expect(subject, name).not.toMatch(/@|\d{5,}|Dr\.|Dra\./);
    }
  });

  it("el cambio de enlace muestra el enlace nuevo y avisa que el anterior dejó de funcionar", async () => {
    const email = await render("doctor_site_slug_changed");
    expect(email.text).toContain("https://agenda.example.com/c/clinica-nueva");
    expect(email.text).toContain("dejó de funcionar");
  });

  it("el cambio de enlace rechaza un nombre con formato inválido", async () => {
    await expect(render("doctor_site_slug_changed", { doctorId: 1, slug: "../admin" })).rejects.toThrow();
  });

  it("la suspensión indica que las citas agendadas se conservan", async () => {
    expect((await render("doctor_account_suspended")).text).toContain("se conservan");
  });
});
