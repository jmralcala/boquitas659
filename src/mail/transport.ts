import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** Transporte SMTP real (nodemailer). Puerto 465 usa TLS directo; los demás negocian STARTTLS. */
export function createSmtpTransport(config: SmtpConfig): MailTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
  return {
    async send(message) {
      await transporter.sendMail({ from: config.from, ...message });
    },
  };
}

export interface MemoryTransport extends MailTransport {
  readonly sent: readonly MailMessage[];
  /** Hace fallar los próximos `count` envíos (para probar reintentos). */
  failNext(count: number): void;
}

/** Transporte en memoria para pruebas y desarrollo sin SMTP. */
export function createMemoryTransport(): MemoryTransport {
  const sent: MailMessage[] = [];
  let failures = 0;
  return {
    sent,
    failNext(count) {
      failures = count;
    },
    async send(message) {
      if (failures > 0) {
        failures -= 1;
        const error = new Error("Fallo simulado del transporte") as Error & { code: string };
        error.code = "ETRANSPORT";
        throw error;
      }
      sent.push(message);
    },
  };
}
