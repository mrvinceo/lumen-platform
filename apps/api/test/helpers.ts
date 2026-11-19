import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalKeyProvider } from "@lumen/crypto";
import { createDb, type DbHandle } from "@lumen/db";
import { runMigrations } from "@lumen/db/migrate";
import {
  deleteDocument,
  deleteKnowledgeBase,
  fsObjectStore,
  type IngestionJob,
  type IngestionQueue,
  ingestDocument,
  type RuntimeDeps,
} from "@lumen/runtime";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { DEFAULT_WIDGET_LIMITS, type WidgetLimits } from "../src/lib/rateLimit.js";
import { visitorTokenKey } from "../src/lib/visitorToken.js";

/** Stand-ins for the built chat app and loader, so serving and headers can be tested without a build. */
function fakeChatDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumen-chat-dist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>chat</title><div id=root></div>");
  return dir;
}
function fakeWidgetScript(): string {
  const file = join(mkdtempSync(join(tmpdir(), "lumen-widget-")), "widget.js");
  writeFileSync(file, "/* lumen widget */");
  return file;
}

import { createAuth } from "../src/auth.js";

export const ORIGIN = "http://localhost:3000";

export interface TestServer {
  app: FastifyInstance;
  handle: DbHandle;
  /** Jobs the API queued; with the inline queue they have already run. */
  jobs: IngestionJob[];
  close(): Promise<void>;
}

/** Runs queued jobs immediately in-process, standing in for Redis + the worker. */
function inlineQueue(deps: () => RuntimeDeps, jobs: IngestionJob[]): IngestionQueue {
  return {
    async enqueue(job) {
      jobs.push(job);
      if (job.name === "ingest-document") await ingestDocument(deps(), job.data, { retryDelayMs: 1 });
      if (job.name === "delete-document") await deleteDocument(deps(), job.data);
      if (job.name === "delete-knowledge-base") await deleteKnowledgeBase(deps(), job.data);
    },
    close: async () => {},
  };
}

export async function startTestServer(
  opts: {
    fetch?: typeof fetch;
    mode?: "saas" | "selfhost";
    limits?: Partial<WidgetLimits>;
    allowSignups?: boolean;
  } = {},
): Promise<TestServer> {
  const url = process.env.DATABASE_URL!;
  await runMigrations(process.env.DATABASE_ADMIN_URL || url);
  const handle = createDb(url);
  const masterKey = randomBytes(32).toString("base64");
  const auth = createAuth(handle.db, {
    MASTER_KEY: masterKey,
    PUBLIC_URL: ORIGIN,
    CONSOLE_URL: "http://localhost:5173",
    ALLOW_SIGNUPS: opts.allowSignups ?? true,
    MICROSOFT_TENANT_ID: "common",
    NODE_ENV: "test",
  });
  const keys = new LocalKeyProvider(masterKey);
  const objects = fsObjectStore(mkdtempSync(join(tmpdir(), "lumen-api-objects-")));
  const jobs: IngestionJob[] = [];
  const runtime: RuntimeDeps = { db: handle.db, keys, objects, fetch: opts.fetch };
  const app = await buildApp({
    db: handle.db,
    auth,
    keys,
    mode: opts.mode ?? "selfhost",
    allowSignups: opts.allowSignups ?? true,
    logLevel: "silent",
    fetch: opts.fetch,
    objects,
    queue: inlineQueue(() => runtime, jobs),
    maxUploadMb: 1,
    widget: {
      tokenKey: visitorTokenKey(masterKey),
      selfOrigins: [ORIGIN],
      limits: { ...DEFAULT_WIDGET_LIMITS, ...opts.limits },
      chatDist: fakeChatDist(),
      widgetScript: fakeWidgetScript(),
    },
  });
  return {
    app,
    handle,
    jobs,
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
    const isForm = body instanceof FormData;
    let payload: string | Buffer | undefined;
    const headers: Record<string, string> = {
      origin: ORIGIN,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (isForm) {
      const encoded = new Request("http://x", { method: "POST", body });
      headers["content-type"] = encoded.headers.get("content-type") ?? "";
      payload = Buffer.from(await encoded.arrayBuffer());
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.app.inject({ method: method as "GET", url, headers, payload });
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
  upload = (
    url: string,
    files: { name: string; content: string | Uint8Array }[],
    audience?: "public" | "staff",
  ) => {
    const form = new FormData();
    if (audience) form.append("audience", audience);
    for (const f of files) form.append("files", new Blob([f.content]), f.name);
    return this.request("POST", url, form);
  };
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
