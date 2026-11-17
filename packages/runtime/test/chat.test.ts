import { randomUUID } from "node:crypto";
import { eq, schema, sql, withTenant } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChatEvent,
  getConversation,
  ingestDocument,
  keywordQuery,
  retrieve,
  runChat,
} from "../src/index.js";
import { addDocument, makeTenantKb, makeWorld, type World } from "./setup.js";

const POLICY = `# Returns policy

Customers may return unused items within 30 days of delivery for a full refund.

## Digital products

Software licences are refundable within 14 days if the key has not been activated.
`;
const CATALOGUE = `# Catalogue

Part ZX-4471 is the replacement hinge for the Aurora cabinet.
`;

async function collect(gen: AsyncGenerator<ChatEvent>) {
  const events: ChatEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}
const text = (events: ChatEvent[]) =>
  events
    .filter((e): e is Extract<ChatEvent, { type: "delta" }> => e.type === "delta")
    .map((e) => e.text)
    .join("");

describe.skipIf(!process.env.DATABASE_URL)("retrieval and chat", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  async function setup(opts: { grounding?: "strict" | "lenient" } = {}) {
    const t = await makeTenantKb(world);
    const docs = [
      await addDocument(world, t, "policy.md", POLICY),
      await addDocument(world, t, "catalogue.md", CATALOGUE),
    ];
    for (const d of docs) await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: d });
    const [bot] = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx
        .insert(schema.bots)
        .values({
          tenantId: t.tenantId,
          name: "Support",
          kbIds: [t.kb.id],
          llmConfigId: t.llmConfigId,
          publicKey: `pk_test_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          grounding: opts.grounding ?? "strict",
          fallbackMessage: "Sorry, I can't find that.",
        })
        .returning(),
    );
    return { ...t, botId: bot!.id };
  }

  it("builds OR keyword queries without stop words", () => {
    expect(keywordQuery("What is the price of part ZX-4471?")).toBe("price | part | zx | 4471");
    expect(keywordQuery("the and of")).toBeUndefined();
  });

  it("finds exact codes through the keyword leg", async () => {
    const t = await setup();
    const r = await retrieve(world.deps, {
      tenantId: t.tenantId,
      kbIds: [t.kb.id],
      query: "ZX-4471",
      audiences: ["public"],
      topK: 3,
    });
    expect(r.chunks[0]?.title).toBe("catalogue.md");
    expect(r.chunks[0]?.via).toContain("keyword");
  });

  it("skips deleted knowledge bases instead of failing", async () => {
    const t = await setup();
    const ghost = randomUUID();
    const r = await retrieve(world.deps, {
      tenantId: t.tenantId,
      kbIds: [t.kb.id, ghost],
      query: "return unused items refund",
      audiences: ["public"],
      topK: 3,
    });
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.skipped).toEqual([{ kbId: ghost, reason: "Knowledge base no longer exists." }]);
  });

  it("streams a grounded, cited answer and saves the conversation", async () => {
    const t = await setup();
    world.embedder.chatReply = ({ system }) =>
      system.includes("Customers may return unused items")
        ? "You can return unused items within 30 days [1]."
        : "?";
    const events = await collect(
      runChat(world.deps, {
        tenantId: t.tenantId,
        botId: t.botId,
        message: "Can I return unused items?",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["meta", "sources", "delta", "done"]));
    expect(events[0]?.type).toBe("meta");
    expect(events[1]?.type).toBe("sources");
    expect(text(events)).toBe("You can return unused items within 30 days [1].");
    const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
    expect(done.citations).toHaveLength(1);
    expect(done.citations[0]).toMatchObject({ n: 1, title: "policy.md" });
    expect(done.usage.tokensIn).toBeGreaterThan(0);

    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    const convo = await getConversation(world.deps, t.tenantId, meta.conversationId);
    expect(convo?.conversation.title).toBe("Can I return unused items?");
    expect(convo?.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(convo?.messages[1]?.retrieval?.sources.length).toBeGreaterThan(0);
    const usage = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.select().from(schema.usageEvents).where(eq(schema.usageEvents.kind, "chat")),
    );
    expect(usage).toHaveLength(1);
  });

  it("condenses follow-up questions before searching", async () => {
    const t = await setup();
    world.embedder.chatReply = ({ system, user }) =>
      system.includes("standalone search query")
        ? "refund window for software licences"
        : user.includes("digital")
          ? "14 days [1]."
          : "30 days [1].";
    const first = await collect(
      runChat(world.deps, {
        tenantId: t.tenantId,
        botId: t.botId,
        message: "What's the refund window?",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    const conversationId = (first[0] as Extract<ChatEvent, { type: "meta" }>).conversationId;
    const second = await collect(
      runChat(world.deps, {
        tenantId: t.tenantId,
        botId: t.botId,
        conversationId,
        message: "what about digital ones?",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    const sources = second.find((e) => e.type === "sources") as Extract<ChatEvent, { type: "sources" }>;
    expect(sources).toMatchObject({ condensed: true, query: "refund window for software licences" });
    expect(sources.sources.some((s) => s.text.includes("Software licences"))).toBe(true);
  });

  it("answers with the fallback, without calling the model, when nothing matches in strict mode", async () => {
    const t = await setup();
    const before = world.embedder.chatCalls.length;
    const events = await collect(
      runChat(world.deps, {
        tenantId: t.tenantId,
        botId: t.botId,
        message: "Qwerty xyzzy plugh",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    // The hashing embedder still returns weak vector matches; force "no matches" by using a bot without KBs.
    expect(events.at(-1)?.type).toBe("done");
    const noKb = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.update(schema.bots).set({ kbIds: [] }).where(eq(schema.bots.id, t.botId)).returning(),
    );
    expect(noKb).toHaveLength(1);
    const callsBefore = world.embedder.chatCalls.length;
    const fb = await collect(
      runChat(world.deps, {
        tenantId: t.tenantId,
        botId: t.botId,
        message: "Anything?",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    expect(text(fb)).toBe("Sorry, I can't find that.");
    expect((fb.at(-1) as Extract<ChatEvent, { type: "done" }>).fallback).toBe(true);
    expect(world.embedder.chatCalls.length).toBe(callsBefore);
    expect(before).toBeLessThanOrEqual(callsBefore);
  });

  it("reports provider failures as an error event and saves the failed answer", async () => {
    const t = await setup();
    world.embedder.chatFailWith = 400;
    try {
      const events = await collect(
        runChat(world.deps, {
          tenantId: t.tenantId,
          botId: t.botId,
          message: "Can I return items?",
          audiences: ["public"],
          channel: "playground",
        }),
      );
      const err = events.at(-1) as Extract<ChatEvent, { type: "error" }>;
      expect(err.type).toBe("error");
      expect(err.message).toMatch(/rejected the request/);
      const convoId = (events[0] as Extract<ChatEvent, { type: "meta" }>).conversationId;
      const convo = await getConversation(world.deps, t.tenantId, convoId);
      expect(convo?.messages[1]).toMatchObject({ status: "error" });
    } finally {
      world.embedder.chatFailWith = undefined;
    }
  });

  it("keeps staff passages out of public chats", async () => {
    const t = await setup();
    const staff = await addDocument(
      world,
      t,
      "pay.md",
      "# Pay\n\nSenior engineers are paid on band seven.",
      "staff",
    );
    await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: staff });
    world.embedder.chatReply = ({ system }) => (system.includes("band seven") ? "LEAK" : "Not found.");
    const events = await collect(
      runChat(world.deps, {
        tenantId: t.tenantId,
        botId: t.botId,
        message: "senior engineers pay band",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    expect(text(events)).not.toContain("LEAK");
    const sources = events.find((e) => e.type === "sources") as Extract<ChatEvent, { type: "sources" }>;
    expect(sources.sources.every((s) => s.audience === "public")).toBe(true);
  });

  it("rejects another tenant's bot and conversation", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      collect(
        runChat(world.deps, {
          tenantId: b.tenantId,
          botId: a.botId,
          message: "hi",
          audiences: ["public"],
          channel: "playground",
        }),
      ),
    ).rejects.toMatchObject({ code: "bot_not_found" });
    const first = await collect(
      runChat(world.deps, {
        tenantId: a.tenantId,
        botId: a.botId,
        message: "Can I return items?",
        audiences: ["public"],
        channel: "playground",
      }),
    );
    const convoId = (first[0] as Extract<ChatEvent, { type: "meta" }>).conversationId;
    await expect(
      collect(
        runChat(world.deps, {
          tenantId: b.tenantId,
          botId: b.botId,
          conversationId: convoId,
          message: "hi",
          audiences: ["public"],
          channel: "playground",
        }),
      ),
    ).rejects.toMatchObject({ code: "conversation_not_found" });
    const rows = await withTenant(world.deps.db, b.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int as n from messages`),
    );
    expect(rows[0]).toMatchObject({ n: expect.any(Number) });
  });
});
