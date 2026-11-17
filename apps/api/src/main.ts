import { keyProviderFromEnv } from "@lumen/crypto";
import { createDb } from "@lumen/db";
import { parseServerEnv } from "@lumen/shared";
import { buildApp } from "./app.js";

const env = parseServerEnv();
// Fail fast if the master key is missing or malformed.
keyProviderFromEnv(env);

const { db, close } = createDb(env.DATABASE_URL);
const app = await buildApp({ db, logLevel: env.LOG_LEVEL });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await close();
    process.exit(0);
  });
}
