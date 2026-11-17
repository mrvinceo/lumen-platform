import { keyProviderFromEnv } from "@lumen/crypto";
import { createDb } from "@lumen/db";
import {
  createObjectStore,
  deleteDocument,
  deleteKnowledgeBase,
  INGESTION_QUEUE,
  type IngestionJob,
  type IngestionJobData,
  ingestDocument,
  type RuntimeDeps,
  redisConnection,
} from "@lumen/runtime";
import { parseServerEnv } from "@lumen/shared";
import { UnrecoverableError, Worker } from "bullmq";
import pino from "pino";

const env = parseServerEnv();
const log = pino({ level: env.LOG_LEVEL });
const { db, close } = createDb(env.DATABASE_URL);
const deps: RuntimeDeps = {
  db,
  keys: keyProviderFromEnv({
    KEY_PROVIDER: env.KEY_PROVIDER,
    MASTER_KEY: env.MASTER_KEY,
    MASTER_KEY_ID: env.MASTER_KEY_ID,
  }),
  objects: createObjectStore(env),
};

/** Runs one queued job. Throwing makes BullMQ retry with backoff; UnrecoverableError stops retries. */
export async function processJob(
  name: IngestionJob["name"],
  data: IngestionJobData,
  attempt: number,
  maxAttempts: number,
) {
  switch (name) {
    case "ingest-document": {
      const d = data as Extract<IngestionJob, { name: "ingest-document" }>["data"];
      const result = await ingestDocument(deps, d);
      log.info({ tenantId: d.tenantId, documentId: d.documentId, ...result }, "ingest finished");
      if (result.status === "error" && result.retryable && attempt < maxAttempts) {
        throw new Error(result.error ?? "retryable ingest failure");
      }
      return result;
    }
    case "delete-document": {
      const d = data as Extract<IngestionJob, { name: "delete-document" }>["data"];
      await deleteDocument(deps, d);
      log.info({ tenantId: d.tenantId, documentId: d.documentId }, "document deleted");
      return { deleted: true };
    }
    case "delete-knowledge-base": {
      const d = data as Extract<IngestionJob, { name: "delete-knowledge-base" }>["data"];
      await deleteKnowledgeBase(deps, d);
      log.info({ tenantId: d.tenantId, kbId: d.kbId }, "knowledge base deleted");
      return { deleted: true };
    }
    default:
      throw new UnrecoverableError(`Unknown job ${name}`);
  }
}

const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE,
  (job) =>
    processJob(job.name as IngestionJob["name"], job.data, job.attemptsMade + 1, job.opts.attempts ?? 1),
  { connection: redisConnection(env.REDIS_URL), concurrency: 4 },
);

worker.on("failed", (job, err) =>
  log.warn({ err: err.message, jobId: job?.id, name: job?.name }, "job attempt failed"),
);
log.info({ storage: env.STORAGE_DRIVER }, "worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    await worker.close();
    await close();
    process.exit(0);
  });
}
