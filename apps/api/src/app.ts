import type { Database } from "@lumen/db";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";

export interface AppDeps {
  db: Database;
  logLevel?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    trustProxy: true,
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

  return app;
}
