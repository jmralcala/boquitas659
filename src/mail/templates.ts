import type { Db } from "../db/pool.js";
import type { TokenPurpose } from "../modules/auth/one-time-tokens.js";

/** Identificadores que viajan en el outbox (nunca contenido ni datos personales). */
export type EmailPayload = Readonly<Record<string, string | number | null>>;

export interface RenderContext {
  payload: EmailPayload;
  /** Enlace con el token recién creado, o `null` si la plantilla no lleva enlace. */
  link: string | null;
  baseUrl: string;
  db: Db;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html?: string;
}

export interface EmailTemplate {
  /** Si existe, el procesador crea un token de un solo uso al enviar y lo expone como `link`. */
  token?: {
    purpose: TokenPurpose;
    ttlMs: number;
    linkPath: (token: string) => string;
    subject: (payload: EmailPayload) => { userId?: number; invitationId?: number };
  };
  render(context: RenderContext): Promise<RenderedEmail> | RenderedEmail;
}

export type TemplateRegistry = Readonly<Record<string, EmailTemplate>>;

/**
 * Plantillas de la aplicación, en español y sin datos personales en el asunto.
 * Cada historia añade las suyas aquí (ver `contracts/email-notifications.md`).
 */
export const defaultTemplates: Record<string, EmailTemplate> = {};
