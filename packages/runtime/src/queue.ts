import { Queue } from "bullmq";

export const INGESTION_QUEUE = "ingestion";

export type IngestionJob =
  | { name: "ingest-document"; data: { tenantId: string; documentId: string; jobId: string } }
  | { name: "delete-document"; data: { tenantId: string; documentId: string } }
  | { name: "delete-knowledge-base"; data: { tenantId: string; kbId: string } };

export type IngestionJobData = IngestionJob["data"];

export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export interface IngestionQueue {
  enqueue(job: IngestionJob): Promise<void>;
  close(): Promise<void>;
}

/** Producer side, used by the API. Retries with exponential backoff; the worker decides what is retryable. */
export function createIngestionQueue(redisUrl: string): IngestionQueue {
  const queue = new Queue<IngestionJobData>(INGESTION_QUEUE, { connection: redisConnection(redisUrl) });
  return {
    async enqueue(job) {
      await queue.add(job.name, job.data, {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      });
    },
    close: () => queue.close(),
  };
}
