import { createDb } from "@lumen/db";
import { parseServerEnv } from "@lumen/shared";
import { Worker } from "bullmq";
import pino from "pino";
import { INGESTION_QUEUE, type IngestionJobData, redisConnection } from "./queues.js";

const env = parseServerEnv();
const log = pino({ level: env.LOG_LEVEL });
const { close } = createDb(env.DATABASE_URL);

// Phase 2 replaces this with the real pipeline: sync -> parse -> chunk -> embed -> upsert.
const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE,
  async (job) => {
    log.info(
      { tenantId: job.data.tenantId, jobId: job.data.jobId, kind: job.data.kind },
      "ingestion job received",
    );
  },
  { connection: redisConnection(env.REDIS_URL), concurrency: 4 },
);

worker.on("failed", (job, err) => log.error({ err, jobId: job?.id }, "job failed"));
log.info("worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    await worker.close();
    await close();
    process.exit(0);
  });
}
