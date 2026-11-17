import { and, type Database, eq, MEMBER_ROLES, type MemberRole, schema, withSystem } from "@lumen/db";
import type { FastifyRequest } from "fastify";
import type { Auth } from "../auth.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";

export interface RequestContext {
  userId: string;
  email: string;
  name: string | null;
  tenantId: string;
  role: MemberRole;
}

export function toHeaders(raw: FastifyRequest["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}

export async function getSession(auth: Auth, req: FastifyRequest) {
  return auth.api.getSession({ headers: toHeaders(req.headers) });
}

/**
 * Resolves the signed-in user and their active tenant, and confirms membership. The membership lookup is a
 * deliberate system query: it is how we learn which tenant to scope everything else to.
 */
export async function requireTenant(auth: Auth, db: Database, req: FastifyRequest): Promise<RequestContext> {
  const session = await getSession(auth, req);
  if (!session) throw unauthorized();
  const tenantId = session.session.activeOrganizationId;
  if (!tenantId) throw new HttpError(409, "no_tenant", "Create or select a workspace first.");
  const [membership] = await withSystem(db, (sys) =>
    sys
      .select({ role: schema.members.role })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId), eq(schema.members.userId, session.user.id))),
  );
  if (!membership) throw forbidden("You are not a member of this workspace.");
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    tenantId,
    role: normaliseRole(membership.role),
  };
}

export function normaliseRole(role: string): MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(role) ? (role as MemberRole) : "viewer";
}

const RANK: Record<MemberRole, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

export function requireRole(ctx: RequestContext, minimum: MemberRole): void {
  if (RANK[ctx.role] < RANK[minimum]) forbiddenFor(minimum);
}

function forbiddenFor(minimum: MemberRole): never {
  throw forbidden(`This action needs the ${minimum} role or higher.`);
}
