import { fileURLToPath } from "node:url";
import { keyProviderFromEnv } from "@lumen/crypto";
import { createDb } from "@lumen/db";
import { createIngestionQueue, createObjectStore } from "@lumen/runtime";
import { parseServerEnv } from "@lumen/shared";
import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";

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
const app = await buildApp({
  db,
  auth,
  keys,
  mode: env.LUMEN_MODE,
  objects: createObjectStore(env),
  queue,
  maxUploadMb: env.MAX_UPLOAD_MB,
  logLevel: env.LOG_LEVEL,
  consoleDist: env.CONSOLE_DIST ?? fileURLToPath(new URL("../../console/dist", import.meta.url)),
});

await app.listen({ port: env.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await queue.close();
    await close();
    process.exit(0);
  });
}
