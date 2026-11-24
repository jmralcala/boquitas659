import { beforeEach, describe, expect, it, vi } from "vitest";

const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail: vi.fn() })));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

import { createSmtpTransport } from "../../src/mail/transport.js";

const base = { host: "smtp.example.com", user: "usuario", pass: "clave-de-prueba", from: "no-responder@example.com" };

beforeEach(() => {
  createTransport.mockClear();
});

describe("createSmtpTransport", () => {
  it("en el puerto 465 usa TLS directo", () => {
    createSmtpTransport({ ...base, port: 465 });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, requireTLS: false }));
  });

  it("en otros puertos exige STARTTLS para impedir la degradación a texto plano", () => {
    createSmtpTransport({ ...base, port: 587 });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
  });

  it("define timeouts menores que la reserva de 2 minutos del outbox", () => {
    createSmtpTransport({ ...base, port: 587 });
    const options = (createTransport.mock.calls[0] as unknown as [Record<string, number>])[0];
    for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout"] as const) {
      expect(options[key]).toBeGreaterThan(0);
      expect(options[key]).toBeLessThan(2 * 60_000);
    }
  });

  it("pasa el Reply-To al enviar y no lo añade cuando no hay", async () => {
    const sendMail = vi.fn();
    createTransport.mockReturnValueOnce({ sendMail });
    const transport = createSmtpTransport({ ...base, port: 587 });
    await transport.send({ to: "paciente@example.com", subject: "Hola", text: "Cuerpo", replyTo: "medico@example.com" });
    await transport.send({ to: "paciente@example.com", subject: "Hola", text: "Cuerpo" });
    expect(sendMail).toHaveBeenNthCalledWith(1, expect.objectContaining({ from: "no-responder@example.com", replyTo: "medico@example.com" }));
    expect(sendMail.mock.calls[1]?.[0]).not.toHaveProperty("replyTo");
  });

  it("verifica el certificado y exige TLS 1.2 o superior", () => {
    createSmtpTransport({ ...base, port: 587 });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" } }),
    );
  });
});
