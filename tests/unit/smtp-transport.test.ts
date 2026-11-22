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

  it("verifica el certificado y exige TLS 1.2 o superior", () => {
    createSmtpTransport({ ...base, port: 587 });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" } }),
    );
  });
});
