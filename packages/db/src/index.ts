// Re-exported so apps share this package's drizzle-orm instance (pnpm can install peer-dependent variants).
export { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
export * from "./client.js";
export * as schema from "./schema/index.js";
export * from "./schema/index.js";
