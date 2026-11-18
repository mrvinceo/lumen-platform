import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, schema, sql, withTenant } from "@lumen/db";
import {
  ChatError,
  type ChatEvent,
  monthlyAnswerCount,
  type PublicBot,
  type RuntimeDeps,
  resolvePublicBot,
  runChat,
} from "@lumen/runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, notFound } from "../lib/errors.js";
import { frameAncestors, originAllowed } from "../lib/origins.js";
import type { MonthlyCounter, RateLimiter, WidgetLimits } from "../lib/rateLimit.js";
import { streamChatEvents } from "../lib/sse.js";
import { parse } from "../lib/validate.js";
import {
  signVisitorToken,
  type VisitorClaims,
  verifyVisitorToken,
  visitorIdOrNew,
} from "../lib/visitorToken.js";

export interface PublicRouteDeps {
  runtime: RuntimeDeps;
  limiter: RateLimiter;
  monthly: MonthlyCounter;
  limits: WidgetLimits;
  tokenKey: Buffer;
  tokenTtlSeconds: number;
  /** Lumen's own browser origins (API/console), always allowed to frame the widget for previews. */
  selfOrigins: string[];
  /** Built widget chat app (apps/chat/dist) and loader (packages/widget/dist/widget.js). */
  chatDist?: string;
  widgetScript?: string;
}

const MAX_TURNS = 20;
const channelSchema = z.enum(["widget", "hosted"]);

/** Public branding only: never prompts, models, knowledge-base ids or the tenant. */
function publicConfig(bot: PublicBot) {
  const b = bot.branding;
  return {
    name: bot.name,
    ready: bot.ready,
    branding: {
      title: b.title || bot.name,
      greeting: b.greeting || "Hi! Ask me anything about our products, services and policies.",
      primaryColor: /^#[0-9a-f]{6}$/i.test(b.primaryColor ?? "") ? b.primaryColor : "#4f46e5",
      logoUrl: b.logoUrl?.startsWith("https://") ? b.logoUrl : undefined,
      suggestedQuestions: (b.suggestedQuestions ?? []).slice(0, 4),
      position: b.position === "bottom-left" ? "bottom-left" : "bottom-right",
      theme: b.theme ?? "auto",
    },
  };
}

const channelEnabled = (bot: PublicBot, channel: "widget" | "hosted") =>
  channel === "widget" ? bot.widgetEnabled : bot.hostedPageEnabled;

/** Strip internals from events before they reach anonymous visitors. */
function publicEvent(e: ChatEvent): ChatEvent {
  switch (e.type) {
    case "sources":
      return {
        type: "sources",
        query: "",
        condensed: false,
        skipped: [],
        sources: e.sources.map((s) => ({ ...s, chunkId: "", documentId: "", text: "", score: 0, via: [] })),
      };
    case "done":
      return {
        ...e,
        usage: { tokensIn: 0, tokensOut: 0 },
        citations: e.citations.map((c) => ({ ...c, chunkId: "", documentId: "", snippet: "", score: 0 })),
      };
    case "error":
      return {
        type: "error",
        code: e.code,
        message: "The assistant couldn't answer just now. Please try again.",
        messageId: e.messageId,
      };
    default:
      return e;
  }
}

async function* mapEvents(gen: AsyncIterable<ChatEvent>) {
  for await (const e of gen) yield publicEvent(e);
}

export async function publicRoutes(app: FastifyInstance, deps: PublicRouteDeps): Promise<void> {
  const db = deps.runtime.db;

  const limited = (reply: FastifyReply, retryAfter: number, message: string) => {
    reply.header("retry-after", String(retryAfter));
    return new HttpError(429, "rate_limited", message);
  };

  function visitor(req: FastifyRequest): VisitorClaims {
    const header = req.headers.authorization ?? "";
    const claims = header.startsWith("Bearer ")
      ? verifyVisitorToken(deps.tokenKey, header.slice(7))
      : undefined;
    if (!claims)
      throw new HttpError(401, "session_expired", "Your chat session has expired. Reload to continue.");
    return claims;
  }

  async function liveBot(claims: VisitorClaims) {
    const [bot] = await withTenant(db, claims.tenantId, (tx) =>
      tx
        .select({
          id: schema.bots.id,
          widgetEnabled: schema.bots.widgetEnabled,
          hostedPageEnabled: schema.bots.hostedPageEnabled,
          monthlyMessageCap: schema.bots.monthlyMessageCap,
        })
        .from(schema.bots)
        .where(eq(schema.bots.id, claims.botId)),
    );
    if (!bot || !(claims.channel === "widget" ? bot.widgetEnabled : bot.hostedPageEnabled))
      throw notFound("Assistant");
    return bot;
  }

  app.get<{ Params: { publicKey: string }; Querystring: { channel?: string } }>(
    "/api/public/v1/bots/:publicKey/config",
    async (req, reply) => {
      // The loader on customers' sites reads this (colours, position), so it is readable cross-origin.
      // It only ever contains public branding.
      reply
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=60")
        .header("vary", "origin");
      const channel = parse(channelSchema.default("widget"), req.query.channel);
      const bot = await resolvePublicBot(db, req.params.publicKey);
      if (!bot || !channelEnabled(bot, channel)) throw notFound("Assistant");
      // Lets the loader stay hidden on a site the browser would refuse to frame the chat on.
      const origin = req.headers.origin;
      const embeddable = origin
        ? originAllowed(origin, [...deps.selfOrigins, ...bot.allowedOrigins])
        : undefined;
      return { ...publicConfig(bot), embeddable };
    },
  );

  app.post<{ Params: { publicKey: string } }>(
    "/api/public/v1/bots/:publicKey/session",
    async (req, reply) => {
      const body = parse(
        z.object({ channel: channelSchema.default("widget"), visitorId: z.string().max(64).optional() }),
        req.body ?? {},
      );
      const ip = await deps.limiter.hit(`ip:${req.ip}:session`, deps.limits.sessionsPerIpPerMinute, 60);
      if (!ip.ok)
        throw limited(reply, ip.retryAfter, "Too many requests. Please wait a moment and try again.");
      const bot = await resolvePublicBot(db, req.params.publicKey);
      if (!bot || !channelEnabled(bot, body.channel)) throw notFound("Assistant");
      const visitorId = visitorIdOrNew(body.visitorId);
      const token = signVisitorToken(
        deps.tokenKey,
        { tenantId: bot.tenantId, botId: bot.id, visitorId, channel: body.channel },
        deps.tokenTtlSeconds,
      );
      return { token, visitorId, expiresIn: deps.tokenTtlSeconds };
    },
  );

  app.post("/api/public/v1/chat", async (req, reply) => {
    const claims = visitor(req);
    const body = parse(
      z.object({ message: z.string().trim().min(1).max(2_000), conversationId: z.uuid().optional() }),
      req.body,
    );
    const bot = await liveBot(claims);

    for (const [key, limit, window, message] of [
      [
        `v:${claims.visitorId}:m`,
        deps.limits.messagesPerVisitorPerMinute,
        60,
        "You're sending messages quickly. Please wait a moment.",
      ],
      [
        `v:${claims.visitorId}:d`,
        deps.limits.messagesPerVisitorPerDay,
        86_400,
        "You've reached today's message limit. Please come back tomorrow.",
      ],
      [
        `b:${claims.botId}:m`,
        deps.limits.messagesPerBotPerMinute,
        60,
        "The assistant is very busy right now. Please try again shortly.",
      ],
    ] as const) {
      const r = await deps.limiter.hit(key, limit, window);
      if (!r.ok) throw limited(reply, r.retryAfter, message);
    }
    if (bot.monthlyMessageCap !== null) {
      const used = await deps.monthly.get(
        bot.id,
        () => monthlyAnswerCount(db, claims.tenantId, bot.id),
        false,
      );
      if (used >= bot.monthlyMessageCap) {
        throw new HttpError(
          429,
          "cap_reached",
          "This assistant is unavailable right now. Please try again later.",
        );
      }
    }

    const abort = new AbortController();
    const gen = runChat(deps.runtime, {
      tenantId: claims.tenantId,
      botId: claims.botId,
      conversationId: body.conversationId,
      message: body.message,
      // Anonymous visitors only ever see public documents.
      audiences: ["public"],
      channel: claims.channel,
      visitorId: claims.visitorId,
      maxTurns: MAX_TURNS,
      signal: abort.signal,
    });
    let first: IteratorResult<ChatEvent>;
    try {
      first = await gen.next();
    } catch (err) {
      if (err instanceof ChatError) {
        if (err.code === "conversation_full") throw new HttpError(409, err.code, err.message);
        if (err.code === "model_unavailable")
          throw new HttpError(503, err.code, "This assistant is unavailable right now.");
        throw new HttpError(404, err.code, err.message);
      }
      throw err;
    }
    await deps.monthly.get(bot.id, () => monthlyAnswerCount(db, claims.tenantId, bot.id), true);
    await streamChatEvents(
      req,
      reply,
      first.done ? first : { done: false, value: publicEvent(first.value) },
      mapEvents(gen),
      abort,
    );
  });

  app.get<{ Params: { id: string } }>("/api/public/v1/conversations/:id", async (req) => {
    const claims = visitor(req);
    const id = parse(z.uuid(), req.params.id);
    const result = await withTenant(db, claims.tenantId, async (tx) => {
      const [conv] = await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.id, id),
            eq(schema.conversations.botId, claims.botId),
            eq(schema.conversations.visitorId, claims.visitorId),
          ),
        );
      if (!conv) return undefined;
      return tx
        .select({
          id: schema.messages.id,
          role: schema.messages.role,
          content: schema.messages.content,
          citations: schema.messages.citations,
          status: schema.messages.status,
          feedback: schema.messages.feedback,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, id))
        .orderBy(
          asc(schema.messages.createdAt),
          sql`case when ${schema.messages.role} = 'user' then 0 else 1 end`,
        );
    });
    if (!result) throw notFound("Conversation");
    return {
      messages: result.map((m) => ({
        ...m,
        citations: m.citations.map((c) => ({ n: c.n, title: c.title, headings: c.headings, page: c.page })),
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/public/v1/messages/:id/feedback", async (req) => {
    const claims = visitor(req);
    const id = parse(z.uuid(), req.params.id);
    const { feedback } = parse(z.object({ feedback: z.enum(["up", "down"]).nullable() }), req.body);
    const rows = await withTenant(db, claims.tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`
        update messages m set feedback = ${feedback}
        from conversations c
        where m.id = ${id} and m.role = 'assistant' and c.id = m.conversation_id
          and c.bot_id = ${claims.botId} and c.visitor_id = ${claims.visitorId}
        returning m.id`),
    );
    if (rows.length === 0) throw notFound("Message");
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------------------------------
  // Static assets: the loader script and the chat app (iframe /w/:publicKey and hosted page /b/:publicKey).
  // ------------------------------------------------------------------------------------------------------------

  app.get("/widget.js", async (_req, reply) => {
    // Read per request (it's ~4 KB) so a rebuilt loader is picked up without a restart.
    const widgetJs =
      deps.widgetScript && existsSync(deps.widgetScript) ? readFileSync(deps.widgetScript) : undefined;
    if (!widgetJs) throw notFound("Widget script");
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .header("access-control-allow-origin", "*")
      .header("cross-origin-resource-policy", "cross-origin")
      .send(widgetJs);
  });

  const chatIndex = deps.chatDist ? join(deps.chatDist, "index.html") : undefined;
  const pageHeaders = (reply: FastifyReply, ancestors: string) =>
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "strict-origin-when-cross-origin")
      .header(
        "content-security-policy",
        [
          "default-src 'self'",
          "img-src 'self' https: data:",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          `frame-ancestors ${ancestors}`,
        ].join("; "),
      );

  const notFoundPage = (reply: FastifyReply) =>
    pageHeaders(reply, "'none'")
      .code(404)
      .send(
        "<!doctype html><meta charset=utf-8><title>Not found</title><p style='font-family:system-ui'>This assistant isn't available.</p>",
      );

  app.get<{ Params: { publicKey: string } }>("/w/:publicKey", async (req, reply) => {
    const bot = await resolvePublicBot(db, req.params.publicKey);
    if (!bot?.widgetEnabled || !chatIndex || !existsSync(chatIndex)) return notFoundPage(reply);
    // Browsers enforce this: the iframe only renders on the bot's allowed domains (and in Lumen's own preview).
    return pageHeaders(reply, frameAncestors(deps.selfOrigins, bot.allowedOrigins)).send(
      readFileSync(chatIndex),
    );
  });

  // A sample page with the real embed snippet, for trying the bubble without a website. It is served from Lumen's own
  // origin, which every bot's iframe already allows, so it needs no allowed-website entry.
  app.get<{ Params: { publicKey: string } }>("/t/:publicKey", async (req, reply) => {
    const bot = await resolvePublicBot(db, req.params.publicKey);
    if (!bot?.widgetEnabled) return notFoundPage(reply);
    const name = escapeHtml(bot.branding.title || bot.name);
    const key = escapeHtml(req.params.publicKey);
    return reply
      .type("text/html; charset=utf-8")
      .header("x-robots-tag", "noindex")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Widget test page · ${name}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f6f4ef;color:#1c1917}main{max-width:40rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:1.75rem;margin:0 0 .75rem}p{line-height:1.6;color:#57534e}code{background:#e7e5e4;padding:.1rem .35rem;border-radius:.25rem}</style>
</head><body><main>
<h1>Widget test page</h1>
<p>This sample page shows how <strong>${name}</strong> looks on a website. Use the chat bubble in the corner to try it.</p>
<p>Answers are real and count towards the bot's monthly usage. To add the bubble to your own site, copy the embed code from
the <code>Embed &amp; branding</code> tab in the Lumen console.</p>
</main>
<script src="/widget.js" data-bot="${key}" async></script>
</body></html>`);
  });

  app.get<{ Params: { publicKey: string } }>("/b/:publicKey", async (req, reply) => {
    const bot = await resolvePublicBot(db, req.params.publicKey);
    if (!bot?.hostedPageEnabled || !chatIndex || !existsSync(chatIndex)) return notFoundPage(reply);
    return pageHeaders(reply, frameAncestors(deps.selfOrigins, [])).send(readFileSync(chatIndex));
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
