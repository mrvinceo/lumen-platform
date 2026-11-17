import { randomBytes } from "node:crypto";
import { LocalKeyProvider } from "@lumen/crypto";
import { createDb, type DbHandle } from "@lumen/db";
import { runMigrations } from "@lumen/db/migrate";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";

export const ORIGIN = "http://localhost:3000";

export interface TestServer {
  app: FastifyInstance;
  handle: DbHandle;
  close(): Promise<void>;
}

export async function startTestServer(
  opts: { fetch?: typeof fetch; mode?: "saas" | "selfhost" } = {},
): Promise<TestServer> {
  const url = process.env.DATABASE_URL!;
  await runMigrations(process.env.DATABASE_ADMIN_URL || url);
  const handle = createDb(url);
  const masterKey = randomBytes(32).toString("base64");
  const auth = createAuth(handle.db, {
    MASTER_KEY: masterKey,
    PUBLIC_URL: ORIGIN,
    CONSOLE_URL: "http://localhost:5173",
    ALLOW_SIGNUPS: true,
    MICROSOFT_TENANT_ID: "common",
    NODE_ENV: "test",
  });
  const app = await buildApp({
    db: handle.db,
    auth,
    keys: new LocalKeyProvider(masterKey),
    mode: opts.mode ?? "selfhost",
    logLevel: "silent",
    fetch: opts.fetch,
  });
  return {
    app,
    handle,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

/** A signed-in browser: keeps cookies between requests like a real client. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  async request(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as "GET",
      url,
      headers: {
        origin: ORIGIN,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers["set-cookie"];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = c.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      if (name) this.cookies.set(name.trim(), rest.join("="));
    }
    return { status: res.statusCode, json: () => res.json(), body: res.body };
  }

  get = (url: string) => this.request("GET", url);
  post = (url: string, body: unknown = {}) => this.request("POST", url, body);
  patch = (url: string, body: unknown) => this.request("PATCH", url, body);
  delete = (url: string) => this.request("DELETE", url);
}

export function uniqueEmail(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}@example.test`;
}

/** Signs up a new user and creates (and activates) a workspace for them. */
export async function signUpWithTenant(app: FastifyInstance, label: string) {
  const client = new Client(app);
  const email = uniqueEmail(label);
  const signUp = await client.post("/api/auth/sign-up/email", {
    email,
    password: "correct-horse-battery",
    name: label,
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status} ${signUp.body}`);
  const slug = `${label}-${randomBytes(4).toString("hex")}`;
  const org = await client.post("/api/auth/organization/create", { name: `${label} Inc`, slug });
  if (org.status !== 200) throw new Error(`org create failed: ${org.status} ${org.body}`);
  const tenantId = (org.json() as { id: string }).id;
  return { client, email, tenantId };
}
