import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle, withTenant } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import * as s from "../src/schema/index.js";
import { seedTenant, type TenantFixture, unitVector } from "./fixtures.js";

const url = process.env.DATABASE_URL;

/** Drizzle wraps driver errors; the Postgres message lives on `cause`. */
async function expectPgError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(err, "expected the query to fail").toBeDefined();
  expect(`${err?.message} ${err?.cause?.message ?? ""}`).toMatch(pattern);
}

/** Every table protected by the tenant_isolation policy. Kept explicit so a new table must be added here. */
const TENANT_TABLES = [
  "tenants",
  "members",
  "invitations",
  "audit_log",
  "secrets",
  "provider_configs",
  "vector_stores",
  "knowledge_bases",
  "sources",
  "documents",
  "chunks",
  "embeddings_768",
  "embeddings_1024",
  "embeddings_1536",
  "embeddings_3072",
  "ingestion_jobs",
  "bots",
  "conversations",
  "messages",
  "usage_events",
];

/** Better Auth identity tables: global, and never readable by the runtime role. */
const GLOBAL_TABLES = ["users", "sessions", "accounts", "verifications"];

describe.skipIf(!url)("tenant isolation (Postgres RLS)", () => {
  let handle: DbHandle;
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    await runMigrations(process.env.DATABASE_ADMIN_URL || url!);
    handle = createDb(url!);
    a = await seedTenant(handle.db, "a");
    b = await seedTenant(handle.db, "b");
  });

  afterAll(async () => {
    await handle?.close();
  });

  it("every tenant table has RLS enabled and the tenant_isolation policy", async () => {
    const rows = await handle.db.execute<{ tablename: string; rls: boolean; has_policy: boolean }>(sql`
      select c.relname as tablename, c.relrowsecurity as rls,
             exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = 'tenant_isolation') as has_policy
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    const unprotected = rows
      .filter((r) => !GLOBAL_TABLES.includes(r.tablename) && !(r.rls && r.has_policy))
      .map((r) => r.tablename);
    expect(unprotected).toEqual([]);
    expect(rows.map((r) => r.tablename).sort()).toEqual([...TENANT_TABLES, ...GLOBAL_TABLES].sort());
  });

  it.each(TENANT_TABLES)("%s: a tenant sees only its own rows", async (table) => {
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const rows = await withTenant(handle.db, self.tenantId, (tx) =>
        tx.execute<{ tid: string }>(
          sql`select ${sql.identifier(table === "tenants" ? "id" : "tenant_id")}::text as tid from ${sql.identifier(table)}`,
        ),
      );
      const tids = new Set(rows.map((r) => r.tid));
      expect(tids.has(other.tenantId)).toBe(false);
      if (!table.startsWith("embeddings_") || table === "embeddings_768") {
        expect(tids).toEqual(new Set([self.tenantId]));
      }
    }
  });

  it("returns nothing when no tenant context is set (fail closed)", async () => {
    const count = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local role lumen_app`);
      const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from chunks`);
      return row!.n;
    });
    expect(count).toBe(0);
  });

  it("rejects writing rows that belong to another tenant", async () => {
    await expectPgError(
      withTenant(handle.db, b.tenantId, (tx) =>
        tx.insert(s.auditLog).values({ tenantId: a.tenantId, action: "forged" }),
      ),
      /row-level security/,
    );
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(handle.db, b.tenantId, (tx) =>
      tx.update(s.bots).set({ name: "pwned" }).where(eq(s.bots.id, a.botId)).returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(handle.db, b.tenantId, (tx) =>
      tx.delete(s.chunks).where(eq(s.chunks.id, a.chunkId)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const [still] = await withTenant(handle.db, a.tenantId, (tx) =>
      tx.select().from(s.bots).where(eq(s.bots.id, a.botId)),
    );
    expect(still?.name).toBe("Bot");
  });

  it("composite foreign keys block references to another tenant's rows", async () => {
    // FK checks bypass RLS, so without composite keys tenant B could attach a document to A's source.
    await expectPgError(
      withTenant(handle.db, b.tenantId, (tx) =>
        tx.insert(s.documents).values({
          tenantId: b.tenantId,
          kbId: b.kbId,
          sourceId: a.sourceId,
          externalId: `forged-${randomUUID()}`,
          title: "forged",
        }),
      ),
      /foreign key/,
    );
    await expectPgError(
      withTenant(handle.db, b.tenantId, (tx) =>
        tx.insert(s.providerConfigs).values({
          tenantId: b.tenantId,
          type: "llm",
          provider: "openai",
          model: "m",
          label: "steal key",
          secretId: a.secretId,
        }),
      ),
      /foreign key/,
    );
  });

  it("vector search never crosses tenants", async () => {
    const probe = `[${unitVector(768, 0).join(",")}]`;
    const hits = await withTenant(handle.db, b.tenantId, (tx) =>
      tx.execute<{ chunk_id: string }>(
        sql`select chunk_id from embeddings_768 order by embedding <=> ${probe}::vector limit 50`,
      ),
    );
    const ids = hits.map((h) => h.chunk_id);
    expect(ids).toContain(b.chunkId);
    expect(ids).not.toContain(a.chunkId);
  });

  it.each(GLOBAL_TABLES)("the runtime role cannot read the global %s table", async (table) => {
    await expectPgError(
      withTenant(handle.db, a.tenantId, (tx) => tx.execute(sql`select * from ${sql.identifier(table)}`)),
      /permission denied/,
    );
  });

  it("rejects non-UUID tenant ids before touching the database", async () => {
    await expect(withTenant(handle.db, "'; drop table tenants; --", async () => 1)).rejects.toThrow(/UUID/);
  });
});
