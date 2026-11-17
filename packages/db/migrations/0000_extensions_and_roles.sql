-- pgvector for the platform-managed vector store.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- Runtime role for tenant-scoped transactions (see withTenant()). NOLOGIN: the pool's login user
-- switches to it with SET LOCAL ROLE. Not the table owner and no BYPASSRLS, so RLS always applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumen_app') THEN
    CREATE ROLE lumen_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- Allow the migrating (and, in simple deployments, the runtime) login user to SET ROLE lumen_app.
DO $$
BEGIN
  EXECUTE format('GRANT lumen_app TO %I', current_user);
END
$$;
