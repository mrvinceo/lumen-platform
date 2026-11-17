# Lumen Platform — notes for contributors and AI agents

- Design and phased roadmap: `docs/architecture.md`. Check which phase you are in before adding scope.
- TypeScript monorepo (pnpm + Turborepo). Workspace packages export TS source (`exports` → `src/*.ts`). Apps bundle them with tsup (`noExternal: [/^@lumen\//]`).
- ESM with NodeNext resolution: relative imports need `.js` extensions.

## Tenant isolation rules (do not break)

- All tenant data access goes through `withTenant()` from `@lumen/db`. Use `withSystem()` only for cross-tenant operations: auth, signup, widget key lookup and job scheduling. Keep those call sites minimal.
- Every new tenant-scoped table needs:
  - a `tenant_id` column
  - `tenantIsolation(t.tenantId)` in its table config
  - `tenantScopedId(...)` if other tables will reference it
  - composite `foreignKey({ columns: [t.tenantId, t.xId], ... })` for its references
  - an entry in `TENANT_TABLES` in `packages/db/test/tenantIsolation.test.ts`. The test fails if a table lacks RLS.
- After schema changes, run `pnpm db:generate` and commit the migration. CI fails on drift.

## Auth

- Better Auth (apps/api/src/auth.ts) owns `users`, `sessions`, `accounts`, `verifications` (global, revoked from
  `lumen_app`) and writes `tenants`/`members`/`invitations` as its "organization" tables via the system connection.
- Routes resolve the caller with `requireTenant()` (session → active workspace → membership) and check
  `requireRole()` before writing. Owners/admins manage providers; editors can test; viewers read.

## Providers

- Adapters live in `packages/core/src/providers/*`, built on each provider's official SDK. Add a provider by
  extending `catalog.ts` and `factory.ts`, plus a test that fakes its HTTP API (see `packages/core/test`).
- Tenant-supplied base URLs go through `assertSafeBaseUrl()`; in SaaS mode it blocks private addresses (SSRF).

## Knowledge and ingestion

- Ingestion lives in `packages/runtime/src/pipeline.ts` and runs in the worker (BullMQ `ingestion` queue). The API
  only stores the upload and queues a job. Chunk ids are deterministic, so unchanged chunks are never re-embedded.
- New vector stores implement `VectorStore` (`packages/core/src/vectorStore.ts`) and must pass
  `packages/core/test/contracts/vectorStore.contract.ts`. Scores are normalised to [0, 1].
- Canonical chunk text stays in Postgres (`chunks`); vector stores hold only ids, vectors, `documentId`, `audience`.

## Secrets

- Store provider keys and tokens only through `@lumen/crypto` `encryptSecret` (AAD = tenantId + secretId).
- Never log, return or embed plaintext secrets. Show `maskSecret(last4)` instead.

## Checks before pushing

Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `DATABASE_URL` pointing at a pgvector ≥ 0.7 database) and `pnpm build`.
