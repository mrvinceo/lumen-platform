import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { KeyProvider } from "@lumen/crypto";
import { type Database, sql } from "@lumen/db";
import type { IngestionQueue, ObjectStore } from "@lumen/runtime";
import Fastify, { type FastifyInstance } from "fastify";
import type { Auth } from "./auth.js";
import { HttpError } from "./lib/errors.js";
import {
  DEFAULT_WIDGET_LIMITS,
  type MonthlyCounter,
  memoryMonthlyCounter,
  memoryRateLimiter,
  type RateLimiter,
  type WidgetLimits,
} from "./lib/rateLimit.js";
import { toHeaders } from "./lib/tenantContext.js";
import { botRoutes } from "./routes/bots.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { meRoutes } from "./routes/me.js";
import { providerRoutes } from "./routes/providers.js";
import { publicRoutes } from "./routes/public.js";
import { vectorStoreRoutes } from "./routes/vectorStores.js";

export interface AppDeps {
  db: Database;
  auth?: Auth;
  keys?: KeyProvider;
  mode?: "saas" | "selfhost";
  logLevel?: string;
  /** Directory with the built console; served at / when present. */
  consoleDist?: string;
  objects?: ObjectStore;
  queue?: IngestionQueue;
  maxUploadMb?: number;
  /** Public widget: visitor-token key, limits and built assets. Omit to disable the public surface. */
  widget?: {
    tokenKey: Buffer;
    tokenTtlSeconds?: number;
    limiter?: RateLimiter;
    monthly?: MonthlyCounter;
    limits?: WidgetLimits;
    selfOrigins: string[];
    chatDist?: string;
    widgetScript?: string;
  };
  /** Injected in tests to stub provider HTTP calls. */
  fetch?: typeof fetch;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong." } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return { status: "ready" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  if (deps.auth && deps.keys) {
    const auth = deps.auth;

    // Better Auth works on Fetch API requests; bridge Fastify's request/reply to it.
    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      handler: async (req, reply) => {
        const url = new URL(req.url, `${req.protocol}://${req.headers.host}`);
        const body = req.method === "POST" && req.body !== undefined ? JSON.stringify(req.body) : undefined;
        const res = await auth.handler(
          new Request(url, { method: req.method, headers: toHeaders(req.headers), body }),
        );
        reply.status(res.status);
        const cookies = res.headers.getSetCookie();
        res.headers.forEach((value, key) => {
          if (key !== "set-cookie") reply.header(key, value);
        });
        if (cookies.length > 0) reply.header("set-cookie", cookies);
        return reply.send(res.body ? await res.text() : null);
      },
    });

    await meRoutes(app, { db: deps.db, auth });
    await providerRoutes(app, {
      db: deps.db,
      auth,
      keys: deps.keys,
      mode: deps.mode ?? "selfhost",
      fetch: deps.fetch,
    });

    if (deps.objects && deps.queue) {
      const maxUploadMb = deps.maxUploadMb ?? 50;
      await app.register(fastifyMultipart, {
        limits: { fileSize: maxUploadMb * 1024 * 1024, files: 50, fields: 10 },
        throwFileSizeLimit: false,
      });
      const runtime = { db: deps.db, keys: deps.keys, objects: deps.objects, fetch: deps.fetch };
      await vectorStoreRoutes(app, { runtime, auth });
      await knowledgeRoutes(app, { runtime, auth, queue: deps.queue, maxUploadMb });
      await botRoutes(app, { runtime, auth, mode: deps.mode ?? "selfhost" });
      if (deps.widget) {
        const w = deps.widget;
        await publicRoutes(app, {
          runtime,
          tokenKey: w.tokenKey,
          tokenTtlSeconds: w.tokenTtlSeconds ?? 2 * 60 * 60,
          limiter: w.limiter ?? memoryRateLimiter(),
          monthly: w.monthly ?? memoryMonthlyCounter(),
          limits: w.limits ?? DEFAULT_WIDGET_LIMITS,
          selfOrigins: w.selfOrigins,
          chatDist: w.chatDist,
          widgetScript: w.widgetScript,
        });
        // The chat app's hashed assets (its index.html is served per bot by publicRoutes, with CSP).
        const chatAssets = w.chatDist ? join(resolve(w.chatDist), "assets") : undefined;
        if (chatAssets) {
          // Created if missing so a later build (pnpm dev) is served without restarting.
          mkdirSync(chatAssets, { recursive: true });
          await app.register(fastifyStatic, {
            root: chatAssets,
            prefix: "/chat/assets/",
            decorateReply: false,
            maxAge: "1y",
            immutable: true,
          });
        }
      }
    }
  }

  const dist = deps.consoleDist ? resolve(deps.consoleDist) : undefined;
  if (dist && existsSync(join(dist, "index.html"))) {
    // wildcard: serve whatever is in dist now (a rebuild with new hashed asset names needs no restart).
    await app.register(fastifyStatic, { root: dist, wildcard: true });
    // Single-page app: unknown non-API GETs get index.html so client-side routes work on refresh.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    });
  }

  return app;
}
