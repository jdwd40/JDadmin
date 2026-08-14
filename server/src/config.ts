import { z } from 'zod';

const boolEnv = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => v === true || (typeof v === 'string' && ['true', '1', 'yes'].includes(v.toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  ALLOWED_ORIGINS: z.string().optional(),
  ADMIN_DATABASE_URL: z.string().min(1),
  COINS_DATABASE_URL: z.string().optional(),
  // Optional schema namespace for the Coins tables (defaults to the DB search_path).
  COINS_SCHEMA: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'COINS_SCHEMA must be a simple identifier')
    .optional(),
  DWARF_DATABASE_URL: z.string().optional(),
  DWARF_ADMIN_PRINCIPAL_ID: z.string().uuid().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: boolEnv,
  COOKIE_NAME: z.string().default('jdadmin_session'),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  ALLOW_DESTRUCTIVE: boolEnv,
  PRODUCTION_DESTRUCTIVE_ACK: z.string().optional(),
});

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  allowedOrigins: string[];
  adminDatabaseUrl: string;
  coinsDatabaseUrl?: string;
  coinsSchema?: string;
  dwarfDatabaseUrl?: string;
  dwarfAdminPrincipalId?: string;
  sessionTtlMs: number;
  cookieSecure: boolean;
  cookieName: string;
  loginRateLimit: { max: number; windowMs: number };
  /**
   * Destructive actions are enabled only when explicitly allowed, and in
   * production additionally require the ack phrase to be configured.
   */
  destructiveEnabled: boolean;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const isProduction = parsed.NODE_ENV === 'production';
  const allowDestructive = parsed.ALLOW_DESTRUCTIVE;
  const productionAckOk =
    !isProduction ||
    parsed.PRODUCTION_DESTRUCTIVE_ACK === 'I_UNDERSTAND_DESTRUCTIVE_ACTIONS';
  const destructiveEnabled = allowDestructive && productionAckOk;

  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    port: parsed.PORT,
    allowedOrigins: (parsed.ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminDatabaseUrl: parsed.ADMIN_DATABASE_URL,
    coinsDatabaseUrl: parsed.COINS_DATABASE_URL || undefined,
    coinsSchema: parsed.COINS_SCHEMA || undefined,
    dwarfDatabaseUrl: parsed.DWARF_DATABASE_URL || undefined,
    dwarfAdminPrincipalId: parsed.DWARF_ADMIN_PRINCIPAL_ID || undefined,
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 3_600_000,
    cookieSecure: parsed.COOKIE_SECURE,
    cookieName: parsed.COOKIE_NAME,
    loginRateLimit: {
      max: parsed.LOGIN_RATE_LIMIT_MAX,
      windowMs: parsed.LOGIN_RATE_LIMIT_WINDOW_MS,
    },
    destructiveEnabled,
  });
}
