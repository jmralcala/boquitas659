import type { Db } from "../db/pool.js";
import type { TokenPurpose } from "../modules/auth/one-time-tokens.js";
import { authTemplates } from "../modules/auth/email-templates.js";
import { receptionTemplates } from "../modules/reception/email-templates.js";
import { doctorTemplates } from "../modules/doctors/email-templates.js";
import { calendarTemplates } from "../modules/calendar/email-templates.js";
import { siteTemplates } from "../modules/site/email-templates.js";

/** Identificadores que viajan en el outbox (nunca contenido ni datos personales). */
export type EmailPayload = Readonly<Record<string, string | number | null>>;

export interface RenderContext {
  payload: EmailPayload;
  /** Enlace con el token recién creado, o `null` si la plantilla no lleva enlace. */
  link: string | null;
  baseUrl: string;
  db: Db;
  /** Hora del procesamiento (reloj de la aplicación). */
  now: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html?: string;
  /** `Reply-To` del correo. No se guarda en el outbox: se calcula al enviar. */
  replyTo?: string;
}

export interface EmailTemplate {
  /** Si existe, el procesador crea un token de un solo uso al enviar y lo expone como `link`. */
  token?: {
    purpose: TokenPurpose;
    ttlMs: number;
    linkPath: (token: string) => string;
    subject: (payload: EmailPayload) => { userId?: number; invitationId?: number; appointmentId?: number };
  };
  /**
   * Si devuelve `false` el correo se cancela sin enviarse (ya no tiene sentido). Se evalúa DENTRO de la transacción
   * de envío (`db` es la conexión de esa transacción): la consulta debe usar `SELECT … FOR UPDATE` sobre la fila de la
   * que depende, para que cualquier cambio concurrente quede serializado con la creación del token.
   */
  shouldSend?(context: { payload: EmailPayload; db: Pick<Db, "execute">; now: Date }): Promise<boolean>;
  render(context: RenderContext): Promise<RenderedEmail> | RenderedEmail;
}

export type TemplateRegistry = Readonly<Record<string, EmailTemplate>>;

/**
 * Plantillas de la aplicación, en español y sin datos personales en el asunto.
 * Cada historia añade las suyas aquí (ver `contracts/email-notifications.md`).
 */
export const defaultTemplates: Record<string, EmailTemplate> = {
  ...authTemplates,
  ...doctorTemplates,
  ...receptionTemplates,
  ...calendarTemplates,
  ...siteTemplates,
};
