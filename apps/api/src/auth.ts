import { hkdfSync, randomUUID } from "node:crypto";
import { type Database, schema } from "@lumen/db";
import type { ServerEnv } from "@lumen/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

/** Session-signing secret: explicit AUTH_SECRET, or a key derived from MASTER_KEY (never the master key itself). */
export function authSecret(env: Pick<ServerEnv, "AUTH_SECRET" | "MASTER_KEY">): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  const derived = hkdfSync(
    "sha256",
    Buffer.from(env.MASTER_KEY, "base64"),
    Buffer.alloc(0),
    "lumen-auth-secret-v1",
    32,
  );
  return Buffer.from(derived).toString("base64url");
}

export type AuthEnv = Pick<
  ServerEnv,
  | "AUTH_SECRET"
  | "MASTER_KEY"
  | "PUBLIC_URL"
  | "CONSOLE_URL"
  | "ALLOW_SIGNUPS"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "MICROSOFT_CLIENT_ID"
  | "MICROSOFT_CLIENT_SECRET"
  | "MICROSOFT_TENANT_ID"
  | "NODE_ENV"
>;

/**
 * Better Auth handles console sign-up/sign-in, sessions and tenants (its "organizations").
 * It reads and writes the global identity tables through the system connection; tenant data access
 * elsewhere still goes through withTenant().
 */
export function createAuth(db: Database, env: AuthEnv) {
  const socialProviders: Record<string, unknown> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    socialProviders.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenantId: env.MICROSOFT_TENANT_ID,
    };
  }

  return betterAuth({
    appName: "Lumen",
    baseURL: env.PUBLIC_URL,
    basePath: "/api/auth",
    secret: authSecret(env),
    trustedOrigins: [env.PUBLIC_URL, env.CONSOLE_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        organization: schema.tenants,
        member: schema.members,
        invitation: schema.invitations,
      },
    }),
    advanced: {
      // Tenants and members use uuid primary keys; generate uuids for every model so ids are uniform.
      database: { generateId: () => randomUUID() },
      useSecureCookies: env.PUBLIC_URL.startsWith("https://"),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !env.ALLOW_SIGNUPS,
      minPasswordLength: 10,
    },
    socialProviders,
    rateLimit: { enabled: env.NODE_ENV === "production" },
    plugins: [
      organization({
        allowUserToCreateOrganization: env.ALLOW_SIGNUPS,
        creatorRole: "owner",
        schema: {
          member: { fields: { organizationId: "tenantId" } },
          invitation: { fields: { organizationId: "tenantId" } },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
