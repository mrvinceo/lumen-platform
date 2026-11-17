import { schema, type Tx } from "@lumen/db";
import type { RequestContext } from "./tenantContext.js";

export async function audit(
  tx: Tx,
  ctx: RequestContext,
  action: string,
  target: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(schema.auditLog)
    .values({ tenantId: ctx.tenantId, actorId: ctx.userId, action, target, metadata });
}

/** Postgres 23503: a row is still referenced (e.g. a store used by a knowledge base). */
export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23503" || e?.cause?.code === "23503";
}
