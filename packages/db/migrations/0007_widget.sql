ALTER TABLE "bots" ADD COLUMN "widget_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "hosted_page_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_visitor_idx" ON "conversations" USING btree ("tenant_id","visitor_id");