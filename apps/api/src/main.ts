import { fileURLToPath } from "node:url";
import { keyProviderFromEnv } from "@lumen/crypto";
import { createDb } from "@lumen/db";
import { createIngestionQueue, createObjectStore } from "@lumen/runtime";
import { parseServerEnv } from "@lumen/shared";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { redisMonthlyCounter, redisRateLimiter } from "./lib/rateLimit.js";
import { visitorTokenKey } from "./lib/visitorToken.js";

const env = parseServerEnv();
// Fails fast if the master key is missing or malformed.
const keys = keyProviderFromEnv({
  KEY_PROVIDER: env.KEY_PROVIDER,
  MASTER_KEY: env.MASTER_KEY,
  MASTER_KEY_ID: env.MASTER_KEY_ID,
});

const { db, close } = createDb(env.DATABASE_URL);
const auth = createAuth(db, env);
const queue = createIngestionQueue(env.REDIS_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const app = await buildApp({
  db,
  auth,
  keys,
  mode: env.LUMEN_MODE,
  objects: createObjectStore(env),
  queue,
  maxUploadMb: env.MAX_UPLOAD_MB,
  widget: {
    tokenKey: visitorTokenKey(env.MASTER_KEY),
    tokenTtlSeconds: env.WIDGET_TOKEN_TTL_MIN * 60,
    limiter: redisRateLimiter(redis),
    monthly: redisMonthlyCounter(redis),
    selfOrigins: [...new Set([new URL(env.PUBLIC_URL).origin, new URL(env.CONSOLE_URL).origin])],
    chatDist: env.CHAT_DIST ?? fileURLToPath(new URL("../../chat/dist", import.meta.url)),
    widgetScript:
      env.WIDGET_SCRIPT ?? fileURLToPath(new URL("../../../packages/widget/dist/widget.js", import.meta.url)),
  },
  logLevel: env.LOG_LEVEL,
  consoleDist: env.CONSOLE_DIST ?? fileURLToPath(new URL("../../console/dist", import.meta.url)),
});

await app.listen({ port: env.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await queue.close();
    redis.disconnect();
    await close();
    process.exit(0);
  });
}
