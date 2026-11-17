import { type Database, eq, schema, withSystem } from "@lumen/db";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth.js";
import { unauthorized } from "../lib/errors.js";
import { getSession, normaliseRole } from "../lib/tenantContext.js";

export async function meRoutes(app: FastifyInstance, deps: { db: Database; auth: Auth }): Promise<void> {
  /** The signed-in user, their workspaces (tenants) and the active one. Drives the console shell. */
  app.get("/api/v1/me", async (req) => {
    const session = await getSession(deps.auth, req);
    if (!session) throw unauthorized();
    const memberships = await withSystem(deps.db, (sys) =>
      sys
        .select({
          id: schema.tenants.id,
          name: schema.tenants.name,
          slug: schema.tenants.slug,
          role: schema.members.role,
        })
        .from(schema.members)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.members.tenantId))
        .where(eq(schema.members.userId, session.user.id))
        .orderBy(schema.tenants.name),
    );
    const tenants = memberships.map((m) => ({ ...m, role: normaliseRole(m.role) }));
    const active = tenants.find((t) => t.id === session.session.activeOrganizationId) ?? null;
    return {
      user: { id: session.user.id, email: session.user.email, name: session.user.name ?? null },
      tenant: active,
      tenants,
    };
  });
}
