CREATE TYPE "public"."message_status" AS ENUM('complete', 'error', 'stopped');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status" "message_status" DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "retrieval" jsonb;--> statement-breakpoint
CREATE INDEX "conversations_bot_updated_idx" ON "conversations" USING btree ("tenant_id","bot_id","updated_at");