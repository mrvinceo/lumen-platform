import { type Database, eq, schema, withSystem } from "@lumen/db";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../auth.js";
import { unauthorized } from "../lib/errors.js";
import { getSession, normaliseRole, toHeaders } from "../lib/tenantContext.js";

export async function meRoutes(
  app: FastifyInstance,
  deps: { db: Database; auth: Auth; allowSignups: boolean },
): Promise<void> {
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
          joinedAt: schema.members.createdAt,
        })
        .from(schema.members)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.members.tenantId))
        .where(eq(schema.members.userId, session.user.id))
        .orderBy(schema.tenants.name),
    );
    const tenants = memberships.map(({ joinedAt: _, ...m }) => ({ ...m, role: normaliseRole(m.role) }));
    let active = tenants.find((t) => t.id === session.session.activeOrganizationId) ?? null;
    // A session without a (valid) active workspace, e.g. one created before sign-in picked it: open the
    // most recently joined workspace and store it on the session, so later API calls see the same one.
    const latest = [...memberships].sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())[0];
    if (!active && latest) {
      await deps.auth.api.setActiveOrganization({
        headers: toHeaders(req.headers),
        body: { organizationId: latest.id },
      });
      active = tenants.find((t) => t.id === latest.id) ?? null;
    }
    return {
      user: { id: session.user.id, email: session.user.email, name: session.user.name ?? null },
      tenant: active,
      tenants,
      canCreateWorkspace: deps.allowSignups,
    };
  });
}
