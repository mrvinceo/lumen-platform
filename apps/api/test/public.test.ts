import { sql } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frameAncestors, normaliseAllowedOrigin, originAllowed } from "../src/lib/origins.js";
import { memoryRateLimiter } from "../src/lib/rateLimit.js";
import { signVisitorToken, verifyVisitorToken, visitorTokenKey } from "../src/lib/visitorToken.js";
import { parseSse, setupBot, stubFetch } from "./chatFixtures.js";
import { type Client, signUpWithTenant, startTestServer, type TestServer } from "./helpers.js";

/** An anonymous visitor talking to the public API (no cookies, bearer token only). */
class Visitor {
  token = "";
  visitorId = "";
  constructor(
    private readonly server: TestServer,
    readonly publicKey: string,
    readonly channel: "widget" | "hosted" = "widget",
  ) {}
  async start() {
    const res = await this.server.app.inject({
      method: "POST",
      url: `/api/public/v1/bots/${this.publicKey}/session`,
      payload: { channel: this.channel },
    });
    expect(res.statusCode).toBe(200);
    ({ token: this.token, visitorId: this.visitorId } = res.json() as { token: string; visitorId: string });
    return this;
  }
  req(method: "GET" | "POST", url: string, payload?: unknown) {
    return this.server.app.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${this.token}` },
    });
  }
  chat(message: string, conversationId?: string) {
    return this.req("POST", "/api/public/v1/chat", { message, conversationId });
  }
}

async function publicKeyOf(client: Client, botId: string) {
  return ((await client.get(`/api/v1/bots/${botId}`)).json() as { bot: { publicKey: string } }).bot.publicKey;
}

describe("widget helpers", () => {
  const key = visitorTokenKey(Buffer.alloc(32, 7).toString("base64"));
  const claims = { tenantId: "t", botId: "b", visitorId: "v_x", channel: "widget" as const };

  it("signs and verifies visitor tokens, rejecting tampering and expiry", () => {
    const token = signVisitorToken(key, claims, 60);
    expect(verifyVisitorToken(key, token)).toMatchObject(claims);
    const [payload, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ v: 1, ...claims, botId: "other", exp: 9e9 })).toString("base64url")}.${sig}`;
    expect(verifyVisitorToken(key, forged)).toBeUndefined();
    expect(verifyVisitorToken(key, `${payload}.AAAA`)).toBeUndefined();
    expect(
      verifyVisitorToken(visitorTokenKey(Buffer.alloc(32, 8).toString("base64")), token),
    ).toBeUndefined();
    expect(verifyVisitorToken(key, token, Date.now() + 61_000)).toBeUndefined();
  });

  it("normalises allowed origins and builds frame-ancestors", () => {
    expect(normaliseAllowedOrigin("www.acme.com/", "saas")).toBe("https://www.acme.com");
    expect(normaliseAllowedOrigin("https://*.acme.com", "saas")).toBe("https://*.acme.com");
    expect(normaliseAllowedOrigin("http://localhost:5500", "selfhost")).toBe("http://localhost:5500");
    expect(() => normaliseAllowedOrigin("http://localhost:5500", "saas")).toThrow(/https/);
    // Bare localhost means a local http test server on self-hosted installs; SaaS keeps https.
    expect(normaliseAllowedOrigin("localhost:8080", "selfhost")).toBe("http://localhost:8080");
    expect(normaliseAllowedOrigin("127.0.0.1", "selfhost")).toBe("http://127.0.0.1");
    expect(normaliseAllowedOrigin("localhost:8080", "saas")).toBe("https://localhost:8080");
    expect(originAllowed("null", ["http://localhost:8080"])).toBe(false);
    expect(() => normaliseAllowedOrigin("http://acme.com", "selfhost")).toThrow(/https/);
    expect(() => normaliseAllowedOrigin("https://acme.com/help", "saas")).toThrow(/without a path/);
    expect(() => normaliseAllowedOrigin("intranet", "saas")).toThrow(/full domain/);
    expect(frameAncestors(["https://lumen.test"], ["https://acme.com"])).toBe(
      "'self' https://lumen.test https://acme.com",
    );
    const allowed = ["https://acme.com", "https://*.shop.io", "http://localhost:5500"];
    expect(originAllowed("https://acme.com", allowed)).toBe(true);
    expect(originAllowed("https://help.shop.io", allowed)).toBe(true);
    expect(originAllowed("https://shop.io", allowed)).toBe(false);
    expect(originAllowed("http://acme.com", allowed)).toBe(false);
    expect(originAllowed("https://acme.com.evil.io", allowed)).toBe(false);
    expect(originAllowed("https://evilshop.io", allowed)).toBe(false);
    expect(originAllowed("http://localhost:5500", allowed)).toBe(true);
    expect(originAllowed("http://localhost:5600", allowed)).toBe(false);
    expect(originAllowed("null", allowed)).toBe(false);
  });

  it("limits requests per window", async () => {
    const l = memoryRateLimiter();
    expect((await l.hit("k", 2, 60)).ok).toBe(true);
    expect((await l.hit("k", 2, 60)).ok).toBe(true);
    const third = await l.hit("k", 2, 60);
    expect(third.ok).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("public widget API", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ fetch: stubFetch });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("serves public config without private fields", async () => {
    const { client } = await signUpWithTenant(server.app, "pubcfg");
    const { botId } = await setupBot(client);
    await client.patch(`/api/v1/bots/${botId}`, {
      branding: {
        title: "Acme Help",
        greeting: "Hello!",
        primaryColor: "#0f766e",
        suggestedQuestions: ["Delivery times?"],
      },
    });
    const pk = await publicKeyOf(client, botId);
    const res = await server.app.inject({ url: `/api/public/v1/bots/${pk}/config` });
    expect(res.json()).toEqual({
      name: "Support",
      ready: true,
      branding: expect.objectContaining({
        title: "Acme Help",
        greeting: "Hello!",
        primaryColor: "#0f766e",
        suggestedQuestions: ["Delivery times?"],
      }),
    });
    expect(res.body).not.toMatch(/systemPrompt|llm|kbIds|tenant/i);
    // The loader learns whether the page it runs on may show the chat.
    await client.patch(`/api/v1/bots/${botId}`, { allowedOrigins: ["https://www.acme.com"] });
    const from = (origin: string) =>
      server.app
        .inject({ url: `/api/public/v1/bots/${pk}/config`, headers: { origin } })
        .then((r) => r.json());
    expect(await from("https://www.acme.com")).toMatchObject({ embeddable: true });
    expect(await from("https://other.example")).toMatchObject({ embeddable: false });
    expect(
      (await server.app.inject({ url: "/api/public/v1/bots/pk_live_doesnotexist123456789/config" }))
        .statusCode,
    ).toBe(404);
  });

  it("answers anonymous visitors from public documents only, without leaking internals", async () => {
    const { client } = await signUpWithTenant(server.app, "pubchat");
    const { botId, kbId } = await setupBot(client);
    await client.upload(
      `/api/v1/knowledge-bases/${kbId}/documents`,
      [{ name: "secret.md", content: "# Express\n\nStaff note: express delivery margin is 40%." }],
      "staff",
    );
    const v = await new Visitor(server, await publicKeyOf(client, botId)).start();
    const res = await v.chat("When does express delivery arrive?");
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events.at(-1)?.type).toBe("done");
    const sources = events.find((e) => e.type === "sources")!;
    expect(sources.sources.length).toBeGreaterThan(0);
    for (const s of sources.sources) {
      expect(s.audience).toBe("public");
      expect(s.text).toBe("");
      expect(s.chunkId).toBe("");
    }
    expect(res.body).not.toContain("margin is 40%");
    const done = events.at(-1)!;
    expect(done.citations[0]).toMatchObject({ n: 1, title: "shipping.md", snippet: "" });
    expect(done.usage).toEqual({ tokensIn: 0, tokensOut: 0 });

    // The conversation shows up for the tenant, labelled as a widget conversation.
    const list = (await client.get(`/api/v1/bots/${botId}/conversations`)).json() as {
      conversations: { channel: string }[];
    };
    expect(list.conversations[0]?.channel).toBe("widget");
  });

  it("lets visitors resume and rate only their own conversations", async () => {
    const { client } = await signUpWithTenant(server.app, "pubown");
    const { botId } = await setupBot(client);
    const pk = await publicKeyOf(client, botId);
    const alice = await new Visitor(server, pk).start();
    const bob = await new Visitor(server, pk).start();
    const events = parseSse((await alice.chat("express delivery?")).body);
    const conversationId = events[0]!.conversationId as string;
    const messageId = events.at(-1)!.messageId as string;

    expect(parseSse((await alice.chat("and returns?", conversationId)).body).at(-1)?.type).toBe("done");
    const history = (await alice.req("GET", `/api/public/v1/conversations/${conversationId}`)).json() as {
      messages: unknown[];
    };
    expect(history.messages).toHaveLength(4);
    expect(
      (await alice.req("POST", `/api/public/v1/messages/${messageId}/feedback`, { feedback: "up" }))
        .statusCode,
    ).toBe(200);

    expect((await bob.chat("hi", conversationId)).statusCode).toBe(404);
    expect((await bob.req("GET", `/api/public/v1/conversations/${conversationId}`)).statusCode).toBe(404);
    expect(
      (await bob.req("POST", `/api/public/v1/messages/${messageId}/feedback`, { feedback: "down" }))
        .statusCode,
    ).toBe(404);

    // A visitor of another tenant's bot can't reach it either.
    const other = await signUpWithTenant(server.app, "pubown-b");
    const otherBot = await setupBot(other.client);
    const mallory = await new Visitor(server, await publicKeyOf(other.client, otherBot.botId)).start();
    expect((await mallory.chat("hi", conversationId)).statusCode).toBe(404);
    expect((await mallory.req("GET", `/api/public/v1/conversations/${conversationId}`)).statusCode).toBe(404);
  });

  it("rejects missing, forged and expired tokens", async () => {
    expect(
      (await server.app.inject({ method: "POST", url: "/api/public/v1/chat", payload: { message: "hi" } }))
        .statusCode,
    ).toBe(401);
    const forged = await server.app.inject({
      method: "POST",
      url: "/api/public/v1/chat",
      payload: { message: "hi" },
      headers: { authorization: "Bearer eyJ2IjoxfQ.bogus" },
    });
    expect(forged.json()).toMatchObject({ error: { code: "session_expired" } });
  });

  it("enforces the monthly cap", async () => {
    const { client } = await signUpWithTenant(server.app, "pubcap");
    const { botId } = await setupBot(client);
    await client.patch(`/api/v1/bots/${botId}`, { monthlyMessageCap: 1 });
    const v = await new Visitor(server, await publicKeyOf(client, botId)).start();
    expect((await v.chat("express delivery?")).statusCode).toBe(200);
    const capped = await v.chat("express delivery again?");
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: { code: "cap_reached" } });
    const bot = (
      (await client.get(`/api/v1/bots/${botId}`)).json() as { bot: { publicAnswersThisMonth: number } }
    ).bot;
    expect(bot.publicAnswersThisMonth).toBe(1);
  });

  it("serves the iframe page with frame-ancestors for the bot's domains, and honours the switches", async () => {
    const { client } = await signUpWithTenant(server.app, "pubcsp");
    const { botId } = await setupBot(client);
    const pk = await publicKeyOf(client, botId);
    let page = await server.app.inject({ url: `/w/${pk}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(
      /frame-ancestors 'self' http:\/\/localhost:3000$/,
    );

    const bad = await client.patch(`/api/v1/bots/${botId}`, { allowedOrigins: ["https://acme.com/help"] });
    expect(bad.json()).toMatchObject({ error: { code: "invalid_origin" } });
    const ok = await client.patch(`/api/v1/bots/${botId}`, {
      allowedOrigins: ["acme.com", "https://*.acme.com", "https://acme.com"],
    });
    expect((ok.json() as { bot: { allowedOrigins: string[] } }).bot.allowedOrigins).toEqual([
      "https://acme.com",
      "https://*.acme.com",
    ]);
    page = await server.app.inject({ url: `/w/${pk}` });
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors 'self' http://localhost:3000 https://acme.com https://*.acme.com",
    );

    const hosted = await server.app.inject({ url: `/b/${pk}` });
    expect(hosted.headers["content-security-policy"]).toMatch(
      /frame-ancestors 'self' http:\/\/localhost:3000$/,
    );
    expect(hosted.headers["content-security-policy"]).not.toContain("acme.com");

    // The built-in test page embeds the real snippet, needs no allowed website and can't itself be framed.
    await client.patch(`/api/v1/bots/${botId}`, { name: "Acme <b>Help</b>" });
    const test = await server.app.inject({ url: `/t/${pk}` });
    expect(test.statusCode).toBe(200);
    expect(test.body).toContain(`<script src="/widget.js" data-bot="${pk}" async></script>`);
    expect(test.body).toContain("Acme &#60;b&#62;Help&#60;/b&#62;");
    expect(test.body).not.toContain("<b>Help");
    expect(test.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'$/);
    expect(test.headers["x-robots-tag"]).toBe("noindex");
    const sameOrigin = await server.app.inject({
      url: `/api/public/v1/bots/${pk}/config`,
      headers: { origin: "http://localhost:3000" },
    });
    expect(sameOrigin.json()).toMatchObject({ embeddable: true });
    expect((await server.app.inject({ url: "/t/pk_live_doesnotexist123456789" })).statusCode).toBe(404);
    expect((await server.app.inject({ url: "/t/not-a-key" })).statusCode).toBe(404);

    await client.patch(`/api/v1/bots/${botId}`, { widgetEnabled: false, hostedPageEnabled: false });
    expect((await server.app.inject({ url: `/w/${pk}` })).statusCode).toBe(404);
    expect((await server.app.inject({ url: `/t/${pk}` })).statusCode).toBe(404);
    expect((await server.app.inject({ url: `/b/${pk}` })).statusCode).toBe(404);
    expect((await server.app.inject({ url: `/api/public/v1/bots/${pk}/config` })).statusCode).toBe(404);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/public/v1/bots/${pk}/session`, payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ url: `/api/public/v1/bots/${pk}/config?channel=hosted` })).statusCode,
    ).toBe(404);
  });

  it("serves the loader script cross-origin", async () => {
    const res = await server.app.inject({ url: "/widget.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("only lets editors change embed settings, within their own tenant", async () => {
    const a = await signUpWithTenant(server.app, "pubembed-a");
    const b = await signUpWithTenant(server.app, "pubembed-b");
    const { botId } = await setupBot(a.client);
    expect((await b.client.patch(`/api/v1/bots/${botId}`, { allowedOrigins: ["evil.com"] })).status).toBe(
      404,
    );
    await server.handle.db.execute(sql`update members set role = 'viewer' where tenant_id = ${a.tenantId}`);
    expect((await a.client.patch(`/api/v1/bots/${botId}`, { allowedOrigins: ["acme.com"] })).status).toBe(
      403,
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("public widget rate limits", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ fetch: stubFetch, limits: { messagesPerVisitorPerMinute: 2 } });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("returns 429 with Retry-After when a visitor sends too fast", async () => {
    const { client } = await signUpWithTenant(server.app, "pubrl");
    const { botId } = await setupBot(client);
    const v = await new Visitor(server, await publicKeyOf(client, botId)).start();
    expect((await v.chat("one")).statusCode).toBe(200);
    expect((await v.chat("two")).statusCode).toBe(200);
    const third = await v.chat("three");
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    expect(third.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});
