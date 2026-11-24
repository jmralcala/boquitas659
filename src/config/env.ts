import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";

function isIpOrCidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (extra !== undefined || address === undefined || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  const max = isIP(address) === 4 ? 32 : 128;
  return /^\d+$/.test(prefix) && Number(prefix) <= max;
}

/**
 * Confianza en el proxy inverso del hosting para leer la IP real del cliente.
 * - `false` (por defecto) o `0`: no se confía en `X-Forwarded-For` (la IP es la del socket).
 * - Un entero N (1 a 10): se confía solo en los N últimos saltos, los que añadió la infraestructura propia.
 * - Una lista de IP o CIDR separada por comas: solo se confía en esos proxies.
 * Nunca se acepta `true`: confiaría en todos los saltos y permitiría falsificar la IP (y evadir el límite de peticiones).
 */
const trustProxySchema = z
  .string()
  .default("false")
  .transform((raw, ctx): false | number | string[] => {
    const value = raw.trim();
    if (value === "" || value === "false" || value === "0") return false;
    if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 10) return Number(value);
    const list = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    if (list.length > 0 && list.every(isIpOrCidr)) return list;
    ctx.addIssue({ code: "custom", message: "TRUST_PROXY debe ser false, un número de saltos (1 a 10) o una lista de IP/CIDR" });
    return z.NEVER;
  });

const productionSmtpKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;

const schema = z
  .object({
    APP_ENV: z.enum(["development", "production"]),
    PUBLIC_BASE_URL: z.url(),
    TRUST_PROXY: trustProxySchema,
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
    /** Logos de los micrositios (fuera de la raíz pública). Por defecto, `logos` dentro del directorio de cédulas. */
    LOGO_STORAGE_DIR: z.string().min(1).optional(),
    /** Clave de Google Maps Embed. Sin ella el micrositio muestra la dirección en texto en lugar del mapa. */
    GOOGLE_MAPS_EMBED_KEY: z.string().min(10).optional(),
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
  })
  .transform((value) => ({ ...value, LOGO_STORAGE_DIR: value.LOGO_STORAGE_DIR ?? join(value.CEDULA_STORAGE_DIR, "logos") }));

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
  // Sin proxy configurado, detrás del proxy del hosting todos los clientes compartirían una IP y los límites de
  // peticiones afectarían a todos por igual. Por eso en producción se exige decidirlo (0 = sin proxy).
  if (result.data.APP_ENV === "production" && (source.TRUST_PROXY ?? "").trim() === "") {
    throw new Error("Configuración de entorno inválida: TRUST_PROXY (en producción debe definirse; usa 0 si no hay proxy)");
  }
  return Object.freeze(result.data);
}
