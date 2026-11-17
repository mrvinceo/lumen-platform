# Lumen Platform

A multi-tenant platform for building **RAG chatbots**. Each company (tenant) brings its own:

- **LLM provider and API key**: OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible endpoint
- **Embedding model**: OpenAI, Gemini or Voyage
- **Vector database**: Pinecone, pgvector or Firestore. A platform-managed pgvector store is the default.
- **Document sources**: file upload, Google Drive or OneDrive/SharePoint

From these, the tenant publishes an **embeddable chat widget**. It can be public for customers, or put behind SSO for staff.

The platform runs as a hosted SaaS or self-hosted with Docker Compose.

> **Status:** Phase 0 (foundations) is done. See [docs/architecture.md](docs/architecture.md) for the full design and roadmap.

## Repository layout

```
apps/api        Fastify REST + SSE API (health/readiness today)
apps/worker     BullMQ ingestion worker (skeleton)
packages/db     Drizzle schema, migrations, Postgres RLS, withTenant()
packages/crypto Envelope encryption for tenant secrets
packages/core   Provider interfaces: ChatModel, EmbeddingModel, VectorStore, SourceConnector
packages/shared Env parsing, ids, shared types
deploy/         docker-compose (Postgres+pgvector, Redis, S3-compatible storage, apps)
docs/           Architecture and plan
```

## Getting started

You need Node 22, pnpm 10 and Docker.

Install dependencies:

```bash
pnpm install
```

Create your local config:

```bash
cp .env.example .env
```

In `.env`, choose a `POSTGRES_PASSWORD` and use it in `DATABASE_URL`. Then generate a master key and paste it into `MASTER_KEY`:

```bash
openssl rand -base64 32
```

Start Postgres (with pgvector), Redis and S3-compatible storage:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

Apply the database migrations:

```bash
pnpm db:migrate
```

Run the API and worker in watch mode:

```bash
pnpm dev
```

Check that it's running:

```bash
curl localhost:3000/ready
```

### Self-hosting

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile app up -d --build
```

## Development commands

| Command                     | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `pnpm test`                 | Unit tests. The tenant-isolation suite runs when `DATABASE_URL` is set. |
| `pnpm typecheck`            | TypeScript across all packages                                          |
| `pnpm lint` / `pnpm format` | Biome                                                                   |
| `pnpm db:generate`          | Generate a migration after changing `packages/db/src/schema`            |
| `pnpm build`                | Bundle apps to `dist/`                                                  |

## Security model (summary)

### Tenant isolation

- Every tenant table has a `tenant_id` and a Postgres RLS policy.
- API and worker code reaches tenant data only through `withTenant(db, tenantId, fn)`. That function sets `app.tenant_id` and switches to the `lumen_app` role, which has no bypass, so RLS holds even when the pool connects as the table owner.
- Composite `(tenant_id, id)` foreign keys stop cross-tenant references. This matters because FK checks bypass RLS.
- The policy fails closed: with no tenant set, queries return no rows.

### Secrets

- Tenant secrets use envelope encryption: a per-secret AES-256-GCM key, wrapped by a master key.
- The tenant id and secret id are bound to the ciphertext, so it cannot be moved to another tenant or row and still decrypt.
- Plaintext is never returned to browsers.

### Widget

- Each bot has a publishable `pk_` key, restricted to the bot's allowed origins.
- Rate limits and monthly caps protect each tenant's provider bill.
