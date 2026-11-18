import { z } from "zod";

/** Server-side configuration shared by api and worker. Parsed once at startup; fails fast on bad config. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LUMEN_MODE: z.enum(["saas", "selfhost"]).default("selfhost"),
  /** Where the API (and, in production, the bundled console) is reachable from browsers. */
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  /** Extra browser origin allowed to call the auth endpoints, e.g. the Vite dev server for the console. */
  CONSOLE_URL: z.url().default("http://localhost:5173"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  KEY_PROVIDER: z.enum(["local"]).default("local"),
  MASTER_KEY: z.string().min(1),
  MASTER_KEY_ID: z.string().default("local-v1"),
  /** Where uploaded originals are stored: local disk (dev, small installs) or any S3-compatible service. */
  STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  /** Directory for STORAGE_DRIVER=fs. Defaults to .data/uploads in the repository. */
  STORAGE_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(200).default(50),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("lumen-uploads"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Signs session cookies. Derived from MASTER_KEY when unset, so self-hosters have one less secret to manage. */
  AUTH_SECRET: z.string().min(32).optional(),
  /** Set to false to stop new people signing up (e.g. a private self-hosted install once set up). */
  ALLOW_SIGNUPS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default("common"),
  /** Lifetime of anonymous widget visitor sessions, in minutes. */
  WIDGET_TOKEN_TTL_MIN: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(120),
  /** Built widget chat app (apps/chat/dist) and loader script (packages/widget/dist/widget.js). */
  CHAT_DIST: z.string().optional(),
  WIDGET_SCRIPT: z.string().optional(),
  /** Built console assets to serve from the API in production. */
  CONSOLE_DIST: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  // `.env` files commonly contain blank entries such as `DATABASE_ADMIN_URL=`; treat those as unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const result = serverEnvSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
