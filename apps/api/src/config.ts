import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3001),
  HOST: z.string().default("127.0.0.1"),
  /** Connection used by the running application. Must be a non-owner, non-superuser role so RLS applies. */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Connection used for migrations and seeding (schema owner). */
  MIGRATION_DATABASE_URL: z.string().min(1, "MIGRATION_DATABASE_URL is required"),
  /** Database role the application connects as; receives grants during migrations. */
  APP_DB_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "APP_DB_ROLE must be a simple lowercase identifier")
    .default("pawguild_app"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  WEB_ORIGIN: z.string().optional(),
  /** Sign-in throttling: failed attempts allowed per email / per network address within the window. */
  LOGIN_MAX_FAILURES_PER_EMAIL: z.coerce.number().int().positive().default(5),
  // Generous because a business's staff usually share one public address. Requires correct
  // proxy settings in production (trustProxy) or every user would appear to share the proxy's address.
  LOGIN_MAX_FAILURES_PER_IP: z.coerce.number().int().positive().default(50),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  return parsed.data;
}
