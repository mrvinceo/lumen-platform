import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantIdColumn, tenantIsolation, tenantScopedId, timestamps } from "./_helpers.js";
import { providerConfigs } from "./providers.js";
import { tenants } from "./tenancy.js";

export const groundingEnum = pgEnum("grounding", ["strict", "lenient"]);
export const botModeEnum = pgEnum("bot_mode", ["public", "staff", "both"]);

export interface BotBranding {
  primaryColor?: string;
  logoUrl?: string;
  /** Background behind the logo (or the title initial): a hex colour, or "transparent". */
  logoBackground?: string;
  avatarUrl?: string;
  title?: string;
  greeting?: string;
  suggestedQuestions?: string[];
  position?: "bottom-right" | "bottom-left";
  theme?: "light" | "dark" | "auto";
}

export interface BotSsoConfig {
  /** Signed identity token verified with a per-bot HS256 secret (stored in `secrets`) or a JWKS URL. */
  jwt?: { secretId?: string; jwksUrl?: string; issuer?: string; audience?: string };
  oidc?: { issuer: string; clientId: string; allowedDomains?: string[]; allowedGroups?: string[] };
}

export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kbIds: uuid("kb_ids").array().notNull().default([]),
    llmConfigId: uuid("llm_config_id").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    temperature: real("temperature").notNull().default(0.2),
    topK: integer("top_k").notNull().default(6),
    grounding: groundingEnum("grounding").notNull().default("strict"),
    fallbackMessage: text("fallback_message"),
    branding: jsonb("branding").$type<BotBranding>().notNull().default({}),
    allowedOrigins: text("allowed_origins").array().notNull().default([]),
    /** Publishable widget key (pk_...). Globally unique: it is how an anonymous widget request finds its tenant. */
    publicKey: text("public_key").notNull().unique(),
    mode: botModeEnum("mode").notNull().default("public"),
    ssoConfig: jsonb("sso_config").$type<BotSsoConfig>().notNull().default({}),
    monthlyMessageCap: integer("monthly_message_cap"),
    /** The embeddable bubble (/widget.js + /w/:publicKey). Also needs at least one allowed origin. */
    widgetEnabled: boolean("widget_enabled").notNull().default(true),
    /** The shareable full-page chat at /b/:publicKey. */
    hostedPageEnabled: boolean("hosted_page_enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("bots", t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.llmConfigId],
      foreignColumns: [providerConfigs.tenantId, providerConfigs.id],
    }),
    tenantIsolation(t.tenantId),
  ],
);

export const channelEnum = pgEnum("channel", ["widget", "hosted", "playground", "api"]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    visitorId: text("visitor_id"),
    /** Verified staff identity (SSO `sub`), when present. */
    endUserId: text("end_user_id"),
    channel: channelEnum("channel").notNull().default("widget"),
    /** Shown in conversation lists; taken from the first question. */
    title: text("title"),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("conversations", t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.botId], foreignColumns: [bots.tenantId, bots.id] }).onDelete(
      "cascade",
    ),
    index("conversations_bot_created_idx").on(t.botId, t.createdAt),
    index("conversations_bot_updated_idx").on(t.tenantId, t.botId, t.updatedAt),
    index("conversations_visitor_idx").on(t.tenantId, t.visitorId),
    tenantIsolation(t.tenantId),
  ],
);

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system"]);
export const feedbackEnum = pgEnum("feedback", ["up", "down"]);

export const messageStatusEnum = pgEnum("message_status", ["complete", "error", "stopped"]);

export interface Citation {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  headings?: string[];
  page?: number;
  url?: string;
  snippet: string;
  score: number;
}

/** What retrieval did for an answer: drives the console's "what the bot saw" panel and later analytics. */
export interface RetrievalTrace {
  query: string;
  condensed: boolean;
  sources: { n: number; chunkId: string; documentId: string; title: string; score: number; via: string[] }[];
  skippedKnowledgeBases?: { kbId: string; reason: string }[];
  timingsMs?: { condense?: number; retrieve?: number; firstToken?: number; total?: number };
}

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    latencyMs: integer("latency_ms"),
    feedback: feedbackEnum("feedback"),
    status: messageStatusEnum("status").notNull().default("complete"),
    /** Error shown for a failed answer. */
    error: text("error"),
    retrieval: jsonb("retrieval").$type<RetrievalTrace>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete("cascade"),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    tenantIsolation(t.tenantId),
  ],
);

export const usageKindEnum = pgEnum("usage_kind", ["chat", "embedding_query", "embedding_ingest", "rerank"]);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id"),
    kind: usageKindEnum("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_events_tenant_created_idx").on(t.tenantId, t.createdAt), tenantIsolation(t.tenantId)],
);
