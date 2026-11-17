/** Queue names and job payloads shared by producers (api) and consumers (worker). */
export const INGESTION_QUEUE = "ingestion";

export interface IngestionJobData {
  tenantId: string;
  jobId: string;
  sourceId: string;
  kind: "full_sync" | "incremental_sync" | "reindex" | "delete";
}

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
