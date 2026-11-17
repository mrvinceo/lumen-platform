import type { BotBranding } from "@lumen/db";
import { type Database, schema, sql, withSystem, withTenant } from "@lumen/db";

export interface PublicBot {
  id: string;
  tenantId: string;
  name: string;
  branding: BotBranding;
  allowedOrigins: string[];
  widgetEnabled: boolean;
  hostedPageEnabled: boolean;
  monthlyMessageCap: number | null;
  /** Bot has at least one knowledge base and a chat model, i.e. it can answer. */
  ready: boolean;
}

/**
 * The one cross-tenant lookup the public widget needs: publishable key → bot and tenant. Everything after this
 * runs inside withTenant(). Returns only what the public surface needs (never prompts, models or KB ids).
 */
export async function resolvePublicBot(db: Database, publicKey: string): Promise<PublicBot | undefined> {
  if (!/^pk_(live|test)_[A-Za-z0-9_-]{8,64}$/.test(publicKey)) return undefined;
  const [row] = await withSystem(db, (sys) =>
    sys
      .select({
        id: schema.bots.id,
        tenantId: schema.bots.tenantId,
        name: schema.bots.name,
        branding: schema.bots.branding,
        allowedOrigins: schema.bots.allowedOrigins,
        widgetEnabled: schema.bots.widgetEnabled,
        hostedPageEnabled: schema.bots.hostedPageEnabled,
        monthlyMessageCap: schema.bots.monthlyMessageCap,
        ready: sql<boolean>`cardinality(${schema.bots.kbIds}) > 0`,
      })
      .from(schema.bots)
      .where(sql`${schema.bots.publicKey} = ${publicKey}`),
  );
  return row;
}

/** Assistant answers given by a bot since the start of the current UTC month (for monthly caps). */
export async function monthlyAnswerCount(db: Database, tenantId: string, botId: string): Promise<number> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id
      where c.bot_id = ${botId} and m.role = 'assistant'
        and m.created_at >= date_trunc('month', now() at time zone 'utc')`),
  );
  return rows[0]?.n ?? 0;
}
