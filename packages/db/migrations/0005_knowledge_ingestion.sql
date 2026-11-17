ALTER TYPE "public"."document_status" ADD VALUE 'indexing' BEFORE 'indexed';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'ingest' BEFORE 'reindex';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "token_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "vector_stores" ADD COLUMN "last_check_ok" boolean;--> statement-breakpoint
ALTER TABLE "vector_stores" ADD COLUMN "last_check_message" text;--> statement-breakpoint
ALTER TABLE "vector_stores" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_tenant_id_document_id_documents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vector_stores_one_managed_per_tenant" ON "vector_stores" USING btree ("tenant_id") WHERE provider = 'pgvector_managed';