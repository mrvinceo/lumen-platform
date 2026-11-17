import {
  type Audience,
  buildPrompt,
  type ChatMessage,
  type ChatModel,
  type Citation,
  condenseQuestion,
  createChatModel,
  DEFAULT_FALLBACK,
  extractCitations,
  isProviderId,
  ProviderError,
} from "@lumen/core";
import { and, asc, desc, eq, schema, sql, type Tx, withTenant } from "@lumen/db";
import type { RuntimeDeps } from "./resolve.js";
import { type RetrievedChunk, retrieve } from "./retrieve.js";
import { readSecret } from "./secrets.js";

export type ChatChannel = "playground" | "widget" | "hosted" | "api";

export interface ChatSource {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  headings: string[];
  page?: number;
  text: string;
  score: number;
  via: string[];
  audience: Audience;
}

export type ChatEvent =
  | { type: "meta"; conversationId: string; userMessageId: string }
  | {
      type: "sources";
      query: string;
      condensed: boolean;
      sources: ChatSource[];
      skipped: { kbId: string; reason: string }[];
    }
  | { type: "delta"; text: string }
  | {
      type: "done";
      messageId: string;
      citations: Citation[];
      usage: { tokensIn: number; tokensOut: number };
      finishReason: string;
      latencyMs: number;
      fallback: boolean;
    }
  | { type: "error"; code: string; message: string; messageId?: string };

export interface ChatInput {
  tenantId: string;
  botId: string;
  conversationId?: string;
  message: string;
  audiences: Audience[];
  channel: ChatChannel;
  visitorId?: string;
  endUserId?: string;
  /** Public channels: refuse to continue a conversation with this many user turns already. */
  maxTurns?: number;
  signal?: AbortSignal;
}

export class ChatError extends Error {
  constructor(
    readonly code: "bot_not_found" | "conversation_not_found" | "conversation_full" | "model_unavailable",
    message: string,
  ) {
    super(message);
  }
}

async function chatModelFromConfig(
  tx: Tx,
  deps: RuntimeDeps,
  tenantId: string,
  configId: string,
): Promise<ChatModel> {
  const [cfg] = await tx
    .select()
    .from(schema.providerConfigs)
    .where(and(eq(schema.providerConfigs.id, configId), eq(schema.providerConfigs.tenantId, tenantId)));
  if (cfg?.type !== "llm" || !isProviderId(cfg.provider)) {
    throw new ChatError(
      "model_unavailable",
      "This bot's chat model has been removed. Choose another one in the bot's settings.",
    );
  }
  const apiKey = cfg.secretId ? await readSecret(tx, deps.keys, tenantId, cfg.secretId) : undefined;
  return createChatModel({
    provider: cfg.provider,
    model: cfg.model,
    apiKey,
    baseUrl: cfg.baseUrl ?? undefined,
    fetch: deps.fetch,
  });
}

const toSources = (chunks: RetrievedChunk[]): ChatSource[] =>
  chunks.map((c, i) => ({
    n: i + 1,
    chunkId: c.chunkId,
    documentId: c.documentId,
    title: c.title,
    headings: c.headings,
    page: c.page,
    text: c.text,
    score: c.score,
    via: c.via,
    audience: c.audience,
  }));

/**
 * One grounded chat turn, as a stream of events. Shared by the console playground and (Phase 4) the public widget.
 * Throws ChatError only for problems found before anything is saved (unknown bot or conversation, missing model);
 * everything after that is reported as an `error` event and recorded on the assistant message.
 */
export async function* runChat(deps: RuntimeDeps, input: ChatInput): AsyncGenerator<ChatEvent> {
  const started = performance.now();
  const { tenantId } = input;

  // 1. Load bot, model and conversation; save the user's message.
  const setup = await withTenant(deps.db, tenantId, async (tx) => {
    const [bot] = await tx
      .select()
      .from(schema.bots)
      .where(and(eq(schema.bots.id, input.botId), eq(schema.bots.tenantId, tenantId)));
    if (!bot) throw new ChatError("bot_not_found", "Bot not found.");
    const [tenant] = await tx
      .select({ name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    const model = await chatModelFromConfig(tx, deps, tenantId, bot.llmConfigId);

    let conversationId = input.conversationId;
    let history: ChatMessage[] = [];
    if (conversationId) {
      const [conv] = await tx
        .select()
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.botId, bot.id)));
      // A public visitor may only continue their own conversation (same visitor id, same public channel).
      const ownedByCaller =
        input.visitorId !== undefined
          ? conv?.visitorId === input.visitorId && conv.channel === input.channel
          : conv !== undefined;
      if (!conv || !ownedByCaller) throw new ChatError("conversation_not_found", "Conversation not found.");
      const prior = await tx
        .select({
          role: schema.messages.role,
          content: schema.messages.content,
          status: schema.messages.status,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(desc(schema.messages.createdAt))
        .limit(20);
      if (input.maxTurns !== undefined && prior.filter((m) => m.role === "user").length >= input.maxTurns) {
        throw new ChatError(
          "conversation_full",
          "This conversation is quite long now. Start a new one to continue.",
        );
      }
      history = prior
        .reverse()
        .filter(
          (m) => (m.role === "user" || m.role === "assistant") && m.status === "complete" && m.content.trim(),
        )
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    } else {
      const [conv] = await tx
        .insert(schema.conversations)
        .values({
          tenantId,
          botId: bot.id,
          channel: input.channel,
          visitorId: input.visitorId,
          endUserId: input.endUserId,
          title: input.message.trim().slice(0, 100),
        })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error("insert returned no row");
      conversationId = conv.id;
    }
    const [userMsg] = await tx
      .insert(schema.messages)
      .values({ tenantId, conversationId, role: "user", content: input.message })
      .returning({ id: schema.messages.id });
    if (!userMsg) throw new Error("insert returned no row");
    return {
      bot,
      model,
      conversationId,
      history,
      userMessageId: userMsg.id,
      workspaceName: tenant?.name ?? "this organisation",
    };
  });

  const { bot, model, conversationId, history } = setup;
  yield { type: "meta", conversationId, userMessageId: setup.userMessageId };

  let answer = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let finishReason = "other";
  let firstTokenAt: number | undefined;
  let status: "complete" | "error" | "stopped" = "complete";
  let errorMessage: string | undefined;
  let citations: Citation[] = [];
  let fallback = false;
  const timings: { condense?: number; retrieve?: number; firstToken?: number; total?: number } = {};
  let trace: NonNullable<(typeof schema.messages.$inferInsert)["retrieval"]> = {
    query: input.message,
    condensed: false,
    sources: [],
  };
  let embedUsage: { provider: string; model: string; tokens: number }[] = [];

  try {
    // 2. Retrieval: condense follow-ups, then hybrid search across the bot's knowledge bases.
    const t0 = performance.now();
    const condensed = await condenseQuestion(model, history, input.message, { signal: input.signal });
    tokensIn += condensed.tokensIn;
    tokensOut += condensed.tokensOut;
    timings.condense = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const found = await retrieve(deps, {
      tenantId,
      kbIds: bot.kbIds,
      query: condensed.query,
      audiences: input.audiences,
      topK: bot.topK,
    });
    embedUsage = found.embedUsage;
    timings.retrieve = Math.round(performance.now() - t1);
    const sources = toSources(found.chunks);
    trace = {
      query: condensed.query,
      condensed: condensed.condensed,
      sources: sources.map((s) => ({
        n: s.n,
        chunkId: s.chunkId,
        documentId: s.documentId,
        title: s.title,
        score: s.score,
        via: s.via,
      })),
      skippedKnowledgeBases: found.skipped.length ? found.skipped : undefined,
    };
    yield {
      type: "sources",
      query: condensed.query,
      condensed: condensed.condensed,
      sources,
      skipped: found.skipped,
    };

    const fallbackMessage = bot.fallbackMessage?.trim() || DEFAULT_FALLBACK;
    if (sources.length === 0 && bot.grounding === "strict") {
      // Nothing to ground an answer in: reply with the fallback without spending a model call.
      fallback = true;
      answer = fallbackMessage;
      finishReason = "stop";
      yield { type: "delta", text: answer };
    } else {
      // 3. Generate the answer.
      const prompt = buildPrompt({
        persona: bot.systemPrompt,
        workspaceName: setup.workspaceName,
        grounding: bot.grounding,
        fallbackMessage,
        sources: sources.map((s) => ({
          index: s.n,
          title: s.title,
          headings: s.headings,
          page: s.page,
          text: s.text,
        })),
        history,
        question: input.message,
      });
      for await (const d of model.stream({
        system: prompt.system,
        messages: prompt.messages,
        temperature: bot.temperature,
        signal: input.signal,
      })) {
        if (d.type === "text") {
          firstTokenAt ??= performance.now();
          answer += d.text;
          yield { type: "delta", text: d.text };
        } else if (d.type === "usage") {
          tokensIn += d.tokensIn;
          tokensOut += d.tokensOut;
        } else if (d.type === "done") finishReason = d.finishReason;
      }
      fallback = answer.trim() === fallbackMessage;
      citations = extractCitations(
        answer,
        sources.filter((s) => s.n <= prompt.usedSources.length).map((s) => ({ ...s, index: s.n })),
      );
    }
  } catch (err) {
    if (input.signal?.aborted) {
      status = "stopped";
    } else {
      status = "error";
      errorMessage = err instanceof ProviderError ? err.message : "Something went wrong while answering.";
    }
  }

  // 4. Save the answer (even partial ones), record usage, and finish.
  timings.firstToken = firstTokenAt ? Math.round(firstTokenAt - started) : undefined;
  timings.total = Math.round(performance.now() - started);
  trace.timingsMs = timings;
  const messageId = await withTenant(deps.db, tenantId, async (tx) => {
    const [msg] = await tx
      .insert(schema.messages)
      .values({
        tenantId,
        conversationId,
        role: "assistant",
        content: answer,
        citations,
        tokensIn,
        tokensOut,
        latencyMs: timings.total,
        status,
        error: errorMessage,
        retrieval: trace,
      })
      .returning({ id: schema.messages.id });
    await tx
      .update(schema.conversations)
      .set({ updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));
    if (tokensIn + tokensOut > 0) {
      await tx.insert(schema.usageEvents).values({
        tenantId,
        botId: bot.id,
        kind: "chat",
        provider: model.provider,
        model: model.model,
        tokensIn,
        tokensOut,
      });
    }
    for (const u of embedUsage) {
      await tx.insert(schema.usageEvents).values({
        tenantId,
        botId: bot.id,
        kind: "embedding_query",
        provider: u.provider,
        model: u.model,
        tokensIn: u.tokens,
      });
    }
    return msg?.id ?? "";
  });

  if (status === "error") {
    yield {
      type: "error",
      code: "answer_failed",
      message: errorMessage ?? "Something went wrong.",
      messageId,
    };
    return;
  }
  yield {
    type: "done",
    messageId,
    citations,
    usage: { tokensIn, tokensOut },
    finishReason: status === "stopped" ? "stopped" : finishReason,
    latencyMs: timings.total,
    fallback,
  };
}

/** Conversation transcript for logs and the playground (messages oldest first). */
export async function getConversation(deps: RuntimeDeps, tenantId: string, conversationId: string) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const [conversation] = await tx
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    if (!conversation) return undefined;
    const messages = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(
        asc(schema.messages.createdAt),
        sql`case when ${schema.messages.role} = 'user' then 0 else 1 end`,
      );
    return { conversation, messages };
  });
}
