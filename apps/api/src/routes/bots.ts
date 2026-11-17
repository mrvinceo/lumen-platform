import { DEFAULT_FALLBACK, defaultPersona } from "@lumen/core";
import { and, desc, eq, inArray, lt, ne, schema, sql, withTenant } from "@lumen/db";
import { ChatError, type ChatEvent, getConversation, type RuntimeDeps, runChat } from "@lumen/runtime";
import { newBotPublicKey } from "@lumen/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { audit } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { normaliseAllowedOrigin } from "../lib/origins.js";
import { streamChatEvents } from "../lib/sse.js";
import { requireRole, requireTenant } from "../lib/tenantContext.js";
import { parse } from "../lib/validate.js";

export interface BotRouteDeps {
  runtime: RuntimeDeps;
  auth: Auth;
  mode: "saas" | "selfhost";
}

const brandingSchema = z.object({
  title: z.string().trim().max(60).optional(),
  greeting: z.string().trim().max(300).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #4f46e5.")
    .optional(),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.startsWith("https://"), "The logo must be an https:// image URL.")
    .optional(),
  suggestedQuestions: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
  position: z.enum(["bottom-right", "bottom-left"]).optional(),
  theme: z.enum(["light", "dark", "auto"]).optional(),
});

const botFields = {
  name: z.string().trim().min(1).max(100),
  kbIds: z.array(z.uuid()).max(20),
  llmConfigId: z.uuid(),
  systemPrompt: z.string().max(8_000),
  grounding: z.enum(["strict", "lenient"]),
  fallbackMessage: z.string().trim().max(500),
  topK: z.number().int().min(1).max(20),
};
const createSchema = z.object({
  ...botFields,
  systemPrompt: botFields.systemPrompt.optional(),
  grounding: botFields.grounding.default("strict"),
  fallbackMessage: botFields.fallbackMessage.optional(),
  topK: botFields.topK.default(6),
});
const updateSchema = z
  .object({
    ...botFields,
    branding: brandingSchema,
    allowedOrigins: z.array(z.string().trim().min(1).max(200)).max(20),
    widgetEnabled: z.boolean(),
    hostedPageEnabled: z.boolean(),
    monthlyMessageCap: z.number().int().min(1).max(10_000_000).nullable(),
  })
  .partial();

const chatSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  conversationId: z.uuid().optional(),
  /** Playground only: include staff-only documents (the public widget never can). */
  includeStaff: z.boolean().default(true),
});

const feedbackSchema = z.object({ feedback: z.enum(["up", "down"]).nullable() });

const botSummary = sql`
  select b.id, b.name, b.kb_ids as "kbIds", b.llm_config_id as "llmConfigId", b.system_prompt as "systemPrompt",
         b.grounding, b.fallback_message as "fallbackMessage", b.top_k as "topK", b.public_key as "publicKey",
         b.branding, b.allowed_origins as "allowedOrigins", b.widget_enabled as "widgetEnabled",
         b.hosted_page_enabled as "hostedPageEnabled", b.monthly_message_cap as "monthlyMessageCap",
         (select count(*)::int from messages m join conversations c on c.id = m.conversation_id
           where c.bot_id = b.id and m.role = 'assistant' and c.channel in ('widget', 'hosted')
             and m.created_at >= date_trunc('month', now() at time zone 'utc')) as "publicAnswersThisMonth",
         b.created_at as "createdAt", b.updated_at as "updatedAt",
         p.label as "llmLabel", p.provider as "llmProvider", p.model as "llmModel",
         coalesce((select json_agg(json_build_object('id', k.id, 'name', k.name) order by k.name)
                   from knowledge_bases k where k.id = any(b.kb_ids) and k.status <> 'disabled'), '[]') as "knowledgeBases",
         (select count(*)::int from conversations c where c.bot_id = b.id) as "conversationCount",
         (select max(c.updated_at) from conversations c where c.bot_id = b.id) as "lastActivityAt"
  from bots b join provider_configs p on p.id = b.llm_config_id`;

export async function botRoutes(app: FastifyInstance, deps: BotRouteDeps): Promise<void> {
  const { runtime, auth } = deps;
  const db = runtime.db;
  const ctxOf = (req: Parameters<typeof requireTenant>[2]) => requireTenant(auth, db, req);

  /** Checks that every referenced KB and the chat model belong to this tenant. RLS hides other tenants' rows. */
  async function validateRefs(tenantId: string, refs: { kbIds?: string[]; llmConfigId?: string }) {
    await withTenant(db, tenantId, async (tx) => {
      if (refs.kbIds?.length) {
        const unique = [...new Set(refs.kbIds)];
        const found = await tx
          .select({ id: schema.knowledgeBases.id })
          .from(schema.knowledgeBases)
          .where(
            and(inArray(schema.knowledgeBases.id, unique), ne(schema.knowledgeBases.status, "disabled")),
          );
        if (found.length !== unique.length)
          throw new HttpError(400, "invalid_knowledge_base", "One or more knowledge bases don't exist.");
      }
      if (refs.llmConfigId) {
        const [m] = await tx
          .select({ type: schema.providerConfigs.type })
          .from(schema.providerConfigs)
          .where(eq(schema.providerConfigs.id, refs.llmConfigId));
        if (m?.type !== "llm")
          throw new HttpError(400, "invalid_chat_model", "Choose a chat model from the Models page.");
      }
    });
  }

  const getBot = async (tenantId: string, id: string) => {
    const [row] = await withTenant(db, tenantId, (tx) => tx.execute(sql`${botSummary} where b.id = ${id}`));
    if (!row) throw notFound("Bot");
    return row;
  };

  app.get("/api/v1/bots", async (req) => {
    const ctx = await ctxOf(req);
    const rows = await withTenant(db, ctx.tenantId, (tx) =>
      tx.execute(sql`${botSummary} order by b.created_at desc`),
    );
    return { bots: rows };
  });

  app.get<{ Params: { id: string } }>("/api/v1/bots/:id", async (req) => {
    const ctx = await ctxOf(req);
    return { bot: await getBot(ctx.tenantId, parse(z.uuid(), req.params.id)) };
  });

  app.post("/api/v1/bots", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "editor");
    const body = parse(createSchema, req.body);
    await validateRefs(ctx.tenantId, body);
    const id = await withTenant(db, ctx.tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, ctx.tenantId));
      const [bot] = await tx
        .insert(schema.bots)
        .values({
          tenantId: ctx.tenantId,
          name: body.name,
          kbIds: [...new Set(body.kbIds)],
          llmConfigId: body.llmConfigId,
          systemPrompt: body.systemPrompt ?? defaultPersona(tenant?.name ?? "our organisation"),
          grounding: body.grounding,
          fallbackMessage: body.fallbackMessage || DEFAULT_FALLBACK,
          topK: body.topK,
          publicKey: newBotPublicKey(),
        })
        .returning({ id: schema.bots.id });
      if (!bot) throw new Error("insert returned no row");
      await audit(tx, ctx, "bot.created", bot.id);
      return bot.id;
    });
    return reply.code(201).send({ bot: await getBot(ctx.tenantId, id) });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/bots/:id", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "editor");
    const id = parse(z.uuid(), req.params.id);
    const patch = parse(updateSchema, req.body);
    await getBot(ctx.tenantId, id);
    await validateRefs(ctx.tenantId, patch);
    const allowedOrigins = patch.allowedOrigins
      ? [...new Set(patch.allowedOrigins.map((o) => normaliseAllowedOrigin(o, deps.mode)))]
      : undefined;
    await withTenant(db, ctx.tenantId, async (tx) => {
      await tx
        .update(schema.bots)
        .set({
          ...patch,
          ...(allowedOrigins ? { allowedOrigins } : {}),
          ...(patch.kbIds ? { kbIds: [...new Set(patch.kbIds)] } : {}),
          ...(patch.fallbackMessage !== undefined
            ? { fallbackMessage: patch.fallbackMessage || DEFAULT_FALLBACK }
            : {}),
        })
        .where(eq(schema.bots.id, id));
      await audit(tx, ctx, "bot.updated", id);
    });
    return { bot: await getBot(ctx.tenantId, id) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/bots/:id", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const id = parse(z.uuid(), req.params.id);
    await getBot(ctx.tenantId, id);
    await withTenant(db, ctx.tenantId, async (tx) => {
      await tx.delete(schema.bots).where(eq(schema.bots.id, id));
      await audit(tx, ctx, "bot.deleted", id);
    });
    return reply.code(204).send();
  });

  /**
   * Playground chat, streamed as Server-Sent Events: meta, sources, delta…, then done or error.
   * Errors found before streaming starts (unknown bot or conversation, missing model) are normal JSON errors.
   */
  app.post<{ Params: { id: string } }>("/api/v1/bots/:id/chat", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "editor");
    const botId = parse(z.uuid(), req.params.id);
    const body = parse(chatSchema, req.body);

    const abort = new AbortController();
    const gen = runChat(runtime, {
      tenantId: ctx.tenantId,
      botId,
      conversationId: body.conversationId,
      message: body.message,
      audiences: body.includeStaff ? ["public", "staff"] : ["public"],
      channel: "playground",
      endUserId: ctx.userId,
      signal: abort.signal,
    });
    let first: IteratorResult<ChatEvent>;
    try {
      first = await gen.next();
    } catch (err) {
      if (err instanceof ChatError) {
        const status = err.code === "model_unavailable" ? 409 : 404;
        throw new HttpError(status, err.code, err.message);
      }
      throw err;
    }

    await streamChatEvents(req, reply, first, gen, abort);
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    "/api/v1/bots/:id/conversations",
    async (req) => {
      const ctx = await ctxOf(req);
      const id = parse(z.uuid(), req.params.id);
      const before = req.query.before ? parse(z.iso.datetime(), req.query.before) : undefined;
      await getBot(ctx.tenantId, id);
      const rows = await withTenant(db, ctx.tenantId, (tx) =>
        tx
          .select({
            id: schema.conversations.id,
            title: schema.conversations.title,
            channel: schema.conversations.channel,
            createdAt: schema.conversations.createdAt,
            updatedAt: schema.conversations.updatedAt,
            messageCount: sql<number>`(select count(*)::int from messages m where m.conversation_id = conversations.id)`,
          })
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.botId, id),
              before ? lt(schema.conversations.updatedAt, new Date(before)) : undefined,
            ),
          )
          .orderBy(desc(schema.conversations.updatedAt))
          .limit(50),
      );
      return { conversations: rows };
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/conversations/:id", async (req) => {
    const ctx = await ctxOf(req);
    const id = parse(z.uuid(), req.params.id);
    const found = await getConversation(runtime, ctx.tenantId, id);
    if (!found) throw notFound("Conversation");
    return found;
  });

  app.post<{ Params: { id: string } }>("/api/v1/messages/:id/feedback", async (req) => {
    const ctx = await ctxOf(req);
    const id = parse(z.uuid(), req.params.id);
    const { feedback } = parse(feedbackSchema, req.body);
    const [row] = await withTenant(db, ctx.tenantId, (tx) =>
      tx
        .update(schema.messages)
        .set({ feedback })
        .where(and(eq(schema.messages.id, id), eq(schema.messages.role, "assistant")))
        .returning({ id: schema.messages.id, feedback: schema.messages.feedback }),
    );
    if (!row) throw notFound("Message");
    return { message: row };
  });
}
