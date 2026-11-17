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

## Secrets

- Store provider keys and tokens only through `@lumen/crypto` `encryptSecret` (AAD = tenantId + secretId).
- Never log, return or embed plaintext secrets. Show `maskSecret(last4)` instead.

## Checks before pushing

Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `DATABASE_URL` pointing at a pgvector ≥ 0.7 database) and `pnpm build`.
