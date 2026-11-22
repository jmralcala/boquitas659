import { z } from "zod";

const productionSmtpKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;

const schema = z
  .object({
    APP_ENV: z.enum(["development", "production"]),
    PUBLIC_BASE_URL: z.url(),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32),
    MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
    PASSWORD_HASHER: z.enum(["argon2", "bcrypt"]).default("argon2"),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(3).optional(),
    SUPPORT_EMAIL: z.email().default("soporte@innvend.com"),
    CEDULA_STORAGE_DIR: z.string().min(1),
    RIGHTS_CONTACT_EMAIL: z.email().default("soporte@innvend.com"),
    RIGHTS_RESPONSE_DAYS: z.coerce.number().int().min(1).max(60).default(20),
  })
  .superRefine((value, ctx) => {
    if (value.APP_ENV !== "production") return;
    for (const key of productionSmtpKeys) {
      if (value[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "obligatoria en producción" });
      }
    }
  });

export type Env = Readonly<z.infer<typeof schema>>;

/**
 * Valida las variables de entorno y devuelve un objeto inmutable.
 * El mensaje de error lista solo los nombres de las variables inválidas, nunca sus valores.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(raíz)"))];
    throw new Error(`Configuración de entorno inválida: ${names.join(", ")}`);
  }
  return Object.freeze(result.data);
}
