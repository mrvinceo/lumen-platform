import { sql } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, signUpWithTenant, startTestServer, type TestServer, uniqueEmail } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

interface Me {
  tenant: { id: string; name: string } | null;
  tenants: { id: string }[];
  canCreateWorkspace: boolean;
}

describe.skipIf(!process.env.DATABASE_URL)("signing in again", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server?.close();
  });

  /** A fresh browser (no cookies) signing in with email and password. */
  async function signIn(app: TestServer["app"], email: string) {
    const client = new Client(app);
    const res = await client.post("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(res.status).toBe(200);
    return client;
  }

  it("opens the user's workspace on a new sign-in instead of asking to create one", async () => {
    const { email, tenantId } = await signUpWithTenant(server.app, "relogin");
    const client = await signIn(server.app, email);
    const me = (await client.get("/api/v1/me")).json() as Me;
    expect(me.tenant?.id).toBe(tenantId);
    // Tenant routes work straight away, with no workspace switch.
    expect((await client.get("/api/v1/bots")).status).toBe(200);
  });

  it("opens the most recently joined workspace when the user has several", async () => {
    const { client: first, email } = await signUpWithTenant(server.app, "multi");
    const second = await first.post("/api/auth/organization/create", {
      name: "Second Inc",
      slug: `second-${Date.now()}`,
    });
    const secondId = (second.json() as { id: string }).id;
    const me = (await (await signIn(server.app, email)).get("/api/v1/me")).json() as Me;
    expect(me.tenants).toHaveLength(2);
    expect(me.tenant?.id).toBe(secondId);
  });

  it("still sends a user with no workspace to create one", async () => {
    const client = new Client(server.app);
    const email = uniqueEmail("noworkspace");
    await client.post("/api/auth/sign-up/email", { email, password: PASSWORD, name: "No workspace" });
    const me = (await (await signIn(server.app, email)).get("/api/v1/me")).json() as Me;
    expect(me).toMatchObject({ tenant: null, tenants: [], canCreateWorkspace: true });
  });

  it("repairs a session that has no active workspace (sessions from before this fix)", async () => {
    const { email, tenantId } = await signUpWithTenant(server.app, "oldsession");
    const client = await signIn(server.app, email);
    await server.handle.db.execute(
      sql`update sessions set active_organization_id = null
          where user_id = (select id from users where email = ${email})`,
    );
    expect(((await client.get("/api/v1/me")).json() as Me).tenant?.id).toBe(tenantId);
    // The repair is stored on the session, so tenant routes agree with /me.
    expect((await client.get("/api/v1/bots")).status).toBe(200);
  });

  it("lets existing users sign in to their workspace when sign-ups are turned off", async () => {
    const { email, tenantId } = await signUpWithTenant(server.app, "closed");
    const closed = await startTestServer({ allowSignups: false });
    try {
      const client = await signIn(closed.app, email);
      const me = (await client.get("/api/v1/me")).json() as Me;
      expect(me).toMatchObject({ tenant: { id: tenantId }, canCreateWorkspace: false });
      expect((await client.get("/api/v1/bots")).status).toBe(200);
      // New accounts are still refused.
      const signUp = await new Client(closed.app).post("/api/auth/sign-up/email", {
        email: uniqueEmail("stranger"),
        password: PASSWORD,
        name: "Stranger",
      });
      expect(signUp.status).toBeGreaterThanOrEqual(400);
    } finally {
      await closed.close();
    }
  });
});
