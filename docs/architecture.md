# Lumen Platform — Architecture & Delivery Plan

## Context

Lumen-AI is a working **single-tenant** RAG chatbot built for OCA. It uses Express and React, supports Gemini only, stores vectors in Firestore, indexes Google Drive and Moodle, and has an LTI embed. Several parts are hard-wired to OCA:

- the Gemini key is global
- admin emails are written into `firestore.rules`
- chunking and embedding run **in the browser** (`src/components/AdminPanel.tsx` ~L1250–1420)
- one `chunks` collection serves everyone

The goal is a **general-purpose product**. Any company signs up as an isolated _tenant_ and then:

1. brings its own LLM provider and API key
2. picks an embedding model
3. connects a vector DB
4. connects a document source: uploads, Google Drive or OneDrive/SharePoint
5. publishes an embeddable chatbot for customers (public) and/or staff (SSO)

Decisions already made:

- **separate new repo**
- **Postgres** for the control plane
- **hosted SaaS plus self-host**
- MVP covers OpenAI, Anthropic and Gemini; Pinecone, pgvector and Firestore; Upload, Drive and OneDrive; the widget; and staff SSO

Working name: **Lumen Platform**. It can be renamed later.

---

## 1. Architecture

```
 Customer site / intranet                 Lumen Platform (SaaS or self-host)
 ┌──────────────────────┐   iframe   ┌───────────────┐  REST/SSE  ┌──────────────┐
 │ <script widget.js    │──────────▶│ apps/chat     │──────────▶│ apps/api     │──▶ Tenant LLM (OpenAI/Anthropic/Gemini)
 │  data-bot=pk_...>    │            │ (chat UI)     │            │ (Fastify)    │──▶ Tenant vector DB (Pinecone/pgvector/Firestore)
 └──────────────────────┘            └───────────────┘            │              │──▶ Postgres (control plane, RLS)
 Tenant admins ─────────────────────▶ apps/console (React admin) ─▶│              │──▶ Redis queue
                                                                   └──────┬───────┘
                                                                          ▼
                                                                   apps/worker (BullMQ): sync → parse → chunk → embed → upsert
                                                                          │
                                                       Drive / Graph (OneDrive, SharePoint) / S3-compatible uploads
```

### Stack

All TypeScript, to stay close to your existing skills.

| Concern             | Choice                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo            | pnpm workspaces + Turborepo                                                                                                                                                                     |
| API                 | Fastify + Zod (`fastify-type-provider-zod`), SSE streaming                                                                                                                                      |
| DB / ORM            | Postgres 16 + pgvector, Drizzle ORM + drizzle-kit migrations                                                                                                                                    |
| Queue               | BullMQ on Redis                                                                                                                                                                                 |
| Console auth        | Better Auth (email/password, Google/Microsoft OAuth, organizations plugin = tenants)                                                                                                            |
| LLM / embedding SDK | Official provider SDKs behind our own `ChatModel` / `EmbeddingModel` interfaces: `@anthropic-ai/sdk`, `openai` (also for OpenAI-compatible endpoints), `@google/genai`; Voyage via its REST API |
| Object storage      | S3-compatible (GCS/S3 in SaaS, MinIO for self-host)                                                                                                                                             |
| Frontends           | React 19 + Vite + Tailwind 4 (console, chat); Preact web component (widget loader, <15 KB)                                                                                                      |
| Tests               | Vitest, Testcontainers (Postgres/Redis), Playwright e2e                                                                                                                                         |
| Observability       | pino logs (tenant_id on every line), OpenTelemetry traces                                                                                                                                       |

### Repo layout

```
apps/api        – REST + SSE, auth, tenant resolution, chat orchestration
apps/worker     – ingestion & sync jobs
apps/console    – tenant admin dashboard + onboarding wizard + playground
apps/chat       – hosted chat page rendered inside the widget iframe
packages/widget – <script> loader / web component (bubble, launcher, postMessage bridge)
packages/core   – provider interfaces + adapters (llm/, embeddings/, vectorstores/, connectors/, parsers/, chunking/, retrieval/)
packages/db     – Drizzle schema, migrations, RLS policies, tenant-scoped client
packages/crypto – envelope encryption for tenant secrets
packages/shared – Zod schemas/types shared by api + frontends
deploy/         – docker-compose.yml, Dockerfiles, Helm chart (later)
```

---

## 2. Tenancy & security model

- **Tenant = organization.** Every control-plane table has a `tenant_id`. Postgres **Row-Level Security** runs `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. The API opens each request in a transaction that sets `app.tenant_id`, through `packages/db/withTenant()`. The app role cannot bypass RLS.
- **Roles:** owner, admin, editor (manages sources and bots), viewer (logs and analytics).
- **Secrets** (LLM keys, vector DB keys, OAuth refresh tokens, Firestore service-account JSON) use envelope encryption:
  - Each tenant gets its own data key (AES-256-GCM).
  - That key is wrapped by a master key: GCP KMS or AWS KMS in SaaS, a `MASTER_KEY` env var for self-host.
  - Secrets are never returned to the browser; the console shows only `sk-…abcd`.
  - Decryption happens only in api and worker, at the moment of use.
- **Vector isolation:**
  - BYO stores are isolated by the tenant's own credentials. Inside them, each knowledge base has its own Pinecone namespace or Firestore collection.
  - With the platform-managed pgvector default, rows carry `tenant_id` + `kb_id` and are protected by RLS.
- **Widget keys:**
  - The publishable `pk_` bot key is public.
  - The API checks the `Origin` header against the bot's `allowed_origins`.
  - It then issues a short-lived visitor session JWT and rate-limits per bot, per IP and per visitor (Redis token bucket).
  - Per-tenant monthly token/message caps protect the tenant's own API bill.
- **Prompt-injection hygiene:** retrieved text is wrapped in delimited `<document>` blocks. The system prompt tells the model to treat documents as data. Tool use stays off in the MVP.

---

## 3. Data model (packages/db)

```
tenants(id, name, slug, plan, created_at)
users / sessions / members(tenant_id, user_id, role)        – Better Auth tables
secrets(id, tenant_id, kind, ciphertext, wrapped_dek, last4, created_at)
provider_configs(id, tenant_id, type: llm|embedding|rerank, provider, model, secret_id, base_url?, options jsonb)
vector_stores(id, tenant_id, provider: pinecone|pgvector|firestore, secret_id?, config jsonb)   -- index/host/project/collection
knowledge_bases(id, tenant_id, name, embedding_config_id, vector_store_id, dimension, namespace, status)
sources(id, tenant_id, kb_id, type: upload|gdrive|onedrive, secret_id?, config jsonb /*folder ids, drive id*/,
        audience: public|staff, sync_cursor, schedule, last_synced_at, status)
documents(id, tenant_id, source_id, external_id, title, url, mime, content_hash, version, audience, status, error)
chunks(id, tenant_id, kb_id, document_id, ordinal, text, token_count, content_hash, metadata jsonb)  -- canonical text, store-agnostic
embeddings_{768,1024,1536,3072}(chunk_id, tenant_id, kb_id, embedding vector(n) | halfvec(3072))  -- managed pgvector only, HNSW
ingestion_jobs(id, tenant_id, source_id, kind, status, progress, stats jsonb, error, started_at, finished_at)
bots(id, tenant_id, name, kb_ids[], llm_config_id, system_prompt, temperature, top_k, grounding: strict|lenient,
     fallback_message, branding jsonb, allowed_origins[], public_key, mode: public|staff|both, sso_config jsonb)
conversations(id, tenant_id, bot_id, visitor_id, end_user_id?, channel, created_at)
messages(id, tenant_id, conversation_id, role, content, citations jsonb, tokens_in, tokens_out, latency_ms, feedback)
usage_events(tenant_id, bot_id, kind, provider, model, tokens, created_at)   -- metering for caps/billing later
audit_log(tenant_id, actor_id, action, target, created_at)
```

Rules:

- The **embedding model is locked per knowledge base.** Changing it creates a new KB version and runs a full re-embed in the background, then switches over atomically.
- Canonical chunk text lives in Postgres, so citations, re-embedding and switching vector stores never require re-parsing the source documents.

---

## 4. Adapter interfaces (packages/core)

```ts
interface ChatModel {
  id;
  stream(req: { system; messages; temperature; maxTokens }): AsyncIterable<Delta>;
}
interface EmbeddingModel {
  id;
  dimension;
  maxBatch;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}
interface VectorStore {
  ensureIndex(kb): Promise<void>;
  upsert(kb, items: { id; vector; metadata }[]): Promise<void>;
  query(kb, vector, { topK, filter }): Promise<{ id; score; metadata }[]>;
  deleteByDocument(kb, documentId): Promise<void>;
  healthcheck(): Promise<HealthResult>;
}
interface SourceConnector {
  authorizeUrl?();
  exchangeCode?(); // OAuth
  listChanges(cursor?): AsyncIterable<Change>; // incremental: added/modified/deleted
  fetch(externalId): Promise<{ bytes; mime; title; url; modifiedAt }>;
}
```

### MVP adapters

- **LLM:** OpenAI, Anthropic and Gemini, plus an "OpenAI-compatible" option with a custom `base_url` (Azure OpenAI, Mistral, Groq, Ollama). This last one is almost free to support.
- **Embeddings:** OpenAI `text-embedding-3-small/large`, Gemini `gemini-embedding`, and Voyage, since Anthropic has no embeddings API.
  - A model catalogue file records dimensions and limits, so the console can validate that a model is compatible with the chosen vector store.
- **Vector stores:**
  - _Pinecone:_ tenant API key + index host; one namespace per KB; metadata filter `{kb_id, audience}`.
  - _pgvector:_ the platform-managed default, so tenants can start without any vector DB; a tenant-owned Postgres URL is also allowed.
  - _Firestore:_ tenant service-account JSON; `findNearest` on collection `lumen_kb_{kbId}`, with equality pre-filters on `audience`. This is the pattern in Lumen's `src/lib/vector.ts`. Max 2048 dimensions, enforced at config time.
- **Connectors:**
  - _Upload:_ drag-and-drop to S3-compatible storage. Supports PDF, DOCX, PPTX, XLSX/CSV, MD, TXT and HTML.
  - _Google Drive:_ per-tenant OAuth (`drive.readonly`) or service account. Folder picker; recursive listing; Google Docs/Slides/Sheets exported as text. Incremental sync uses the **Changes API** with `startPageToken`.
  - _OneDrive/SharePoint:_ Microsoft Graph OAuth (`Files.Read.All`, `Sites.Read.All`, offline_access). Folder and drive picker; incremental sync uses **delta queries** (`/drive/items/{id}/delta`).
- **Every adapter passes a shared contract test suite** (`packages/core/test/contracts/*.contract.ts`).

---

## 5. Ingestion pipeline (apps/worker)

The steps run in this order:

1. **Trigger:** a manual "Sync now", a cron schedule (default every 6 h), an upload, or a Drive or Graph change webhook (later).
2. **Diff:** `listChanges(cursor)` returns adds, modifies and deletes.
3. **Download:** fetch each changed file. If its `content_hash` is unchanged, skip it.
4. **Parse:** pdf-parse, mammoth, officeparser and html-to-text, with an optional **Google Document AI** OCR path. Document AI is ported from Lumen `server/documentAiService.ts` and enabled per tenant with the tenant's own GCP key.
5. **Chunk:** heading- and structure-aware recursive splitting, about 500–800 tokens with roughly 15% overlap. Each chunk keeps title, heading path, page number and URL as metadata.
6. **Embed:** batched, with retry and backoff, respecting the provider's rate limits and the tenant's concurrency limit.
7. **Upsert:** write to the vector store first, then commit `chunks` and `documents` in Postgres. Deletes remove vectors by `document_id`.
8. **Report:** update the cursor; record job stats (files, chunks, tokens, cost estimate) and errors in `ingestion_jobs`. The console streams job progress.

All jobs are idempotent: chunk ids are deterministic (`documentId:ordinal:hash`). Failures go to a dead-letter queue and can be retried from the console.

---

## 6. Chat & retrieval (apps/api `POST /v1/bots/:publicKey/chat`, SSE)

1. Resolve the bot and tenant; validate the origin and visitor session; run rate-limit and quota checks.
2. **Determine the audience.** Anonymous visitors get `public`. Staff with a verified SSO token get `public` and `staff`. This is a generalisation of Lumen's `audience` field and its `searchStaffChunks` behaviour.
3. **Condense the query.** For follow-up questions, use the LLM to rewrite the latest message into a standalone question (cheap model, optional).
4. **Embed the query** with the KB's embedding model, then run a vector search with top-k = 20, filtered on `audience ∈ allowed`, across the bot's KBs.
5. **Optional extras:**
   - hybrid keyword search via Postgres FTS on `chunks`, merged using Reciprocal Rank Fusion
   - rerank via Cohere or Voyage if the tenant configured it
   - deduplicate and merge (port `mergeAndRank` from Lumen `src/lib/vector.ts`) down to about the top 6
6. **Build the prompt:** tenant system prompt + grounding rules + numbered `<document id=n title url>` blocks + conversation history, with token budgeting.
7. **Stream the answer** with `[n]` citation markers (Lumen's numbered-marker scheme, commit 7a573d1).
   - Afterwards, send a `citations` event containing title, url and snippet.
   - In `strict` grounding mode, if nothing scores above the threshold, return the configured fallback message (for example "I couldn't find that — contact support@…").
8. **Persist** the message, citations, tokens, latency and usage event. 👍/👎 feedback goes to `messages.feedback`.

---

## 7. Embeddable widget & staff SSO

### Public install

```html
<script src="https://cdn.lumen…/widget.js" data-bot="pk_live_xxx" async></script>
```

- The loader is a Shadow-DOM launcher bubble that opens an **iframe** to `apps/chat`. The iframe gives style isolation, keeps tokens off the host page, and avoids CSP problems.
- A JS API lets the host page control it: `Lumen.open()`, `Lumen.identify({ token })` and `Lumen.on('message', …)`.
- A full-page hosted URL, `https://chat.lumen…/b/pk_live_xxx`, gives every bot a shareable link as well.
- **Branding:** colours, logo, avatar, greeting, suggested questions, position and dark mode. All are configurable in the console with a live preview.

### Staff mode, two options

1. **Signed identity token (simplest):** the tenant's backend signs a JWT carrying `sub`, `email`, `groups` and `audience: staff`. It uses either an HS256 per-bot secret or RS256 with a JWKS URL registered in the console, and passes the token to `Lumen.identify`.
2. **OIDC login inside the widget:** the tenant registers an issuer, client_id and allowed groups or domain (Google Workspace, Entra ID, Okta). The chat iframe runs auth-code + PKCE. Group or domain claims map to `staff`.

Staff conversations are attributed to `end_user_id`, so staff get history across devices.

---

## 8. Console (apps/console)

- **Onboarding wizard:**
  1. Model provider + key → **Test connection**
  2. Embedding model
  3. Vector store → **Test & create index**
  4. Add source: upload / connect Drive / connect OneDrive → pick folders → mark the audience as public or staff
  5. Bot persona: system prompt, tone, fallback, branding
  6. **Playground** (chat showing the retrieved chunks and their scores)
  7. Allowed domains + embed snippet
- **Ongoing management:** sources and sync status, documents list (re-index, exclude), bots, conversation logs, analytics (volume, 👍/👎, unanswered or low-confidence questions = content gaps), usage vs caps, team members, API keys, audit log.
- **UI reuse from Lumen:** `CitationComponents.tsx` (citation chips and popovers) and the Drive folder-ID parsing helper (commit 80702be). Both are ported and cleaned of OCA specifics.

---

## 9. Self-host & deployment

- `deploy/docker-compose.yml` runs api, worker, console, chat, postgres (pgvector), redis and minio. One `.env` holds `DATABASE_URL`, `REDIS_URL`, `S3_*`, `MASTER_KEY`, `PUBLIC_URL` and OAuth app credentials for Google and Microsoft.
- SaaS runs the same images on Cloud Run or Fly, with managed Postgres (Neon, Supabase or Cloud SQL), Upstash or Memorystore Redis, GCS, and KMS.
- A single `LUMEN_MODE=saas|selfhost` flag controls multi-tenant signup, billing hooks and the KMS-vs-env master key.
- CI (GitHub Actions) runs lint, typecheck, unit and contract tests (with Testcontainers), builds images, then runs Playwright e2e against compose.

---

## 10. Phased delivery

| Phase                         | Deliverable                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Bootstrap** ✅           | Monorepo, lint/tsconfig/turbo, docker-compose dev stack, CI, Drizzle schema + RLS + `withTenant`, crypto package                          |
| **1. Tenancy & providers** ✅ | Better Auth with orgs; secrets CRUD; LLM + embedding adapters with test-connection; console shell                                         |
| **2. Ingestion v1** ✅        | Upload connector, parsers, chunker, worker queue, pgvector + Pinecone + Firestore adapters (contract-tested), job progress UI             |
| **3. Chat v1** ✅             | Retrieval pipeline, SSE chat endpoint, citations, conversation persistence, console playground                                            |
| **4. Widget (public)** ✅     | `apps/chat`, widget loader, allowed origins, visitor sessions, rate limits, quotas, branding editor, embed snippet                        |
| **5. Cloud connectors**       | Google Drive + OneDrive/SharePoint OAuth, folder pickers, incremental sync, schedules, deletions                                          |
| **6. Staff SSO**              | Signed-JWT identify + OIDC, audience filtering, staff history                                                                             |
| **7. Hardening**              | Analytics & feedback, usage metering, audit log, OpenTelemetry, RAG eval harness (golden Q&A per tenant), self-host docs, security review |

**Later:** website crawler, Confluence/Notion/Slack channels, Qdrant/Weaviate/Azure AI Search adapters, permission-aware retrieval from Drive and Graph ACLs, Stripe billing, an LTI channel (port from Lumen) that lets OCA become a tenant, voice/TTS (port `audioTtsService.ts`), and agentic tools.

---

## 11. What to port from Lumen-AI (copy and adapt, no shared dependency)

| Lumen source                                                       | Becomes                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `server/documentAiService.ts`                                      | `packages/core/parsers/documentAi.ts` (tenant-keyed)             |
| `server.ts` `/api/drive/list` + `/api/drive/content` (~L2125–2470) | `packages/core/connectors/gdrive.ts` (export formats, recursion) |
| AdminPanel chunking/indexing loop (~L1250–1420)                    | server-side `packages/core/chunking` + worker job                |
| `src/lib/vector.ts` `runNearestSearch` / `mergeAndRank`            | Firestore vector adapter + retrieval merge step                  |
| `src/components/CitationComponents.tsx`                            | `apps/chat` citation UI                                          |
| `audience` field + `docs/staff-audience-indexes.md`                | audience model and Firestore index setup docs for tenants        |

---

## 12. Verification

- **Unit and contract tests (Vitest):**
  - every LLM, embedding, vector store and connector adapter runs the shared contract suite
  - live-provider tests run only when the `*_TEST_KEY` env vars are set, with recorded fixtures otherwise
  - Postgres and Redis tests use Testcontainers
- **Tenant isolation tests:** seed tenants A and B, then assert that every API route and every direct DB query under tenant B's context returns zero rows of A's data. Also assert that retrieval never crosses KBs or namespaces, and that staff-audience chunks never reach anonymous visitors.
- **E2E (Playwright, against docker-compose):**
  1. sign up and create a tenant
  2. add an OpenAI-compatible key (a mock LLM server in CI)
  3. choose pgvector
  4. upload a PDF
  5. wait for the job to finish
  6. ask a question in the playground and assert the answer contains the expected citation
  7. embed the widget on a test page served from an allowed origin; it works
  8. embed it on a disallowed origin; it is rejected
- **Manual checks:**
  - connect a real Google Drive folder and a OneDrive folder; edit a file and confirm incremental sync re-embeds only that file; delete a file and confirm its vectors are removed
  - switch the bot between Pinecone and Firestore KBs
- **Quality:** a small golden question set per demo tenant, run through an eval script that scores retrieval hit-rate@k and answer faithfulness (LLM-as-judge), wired into CI as a non-blocking report.
