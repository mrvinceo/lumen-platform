GRANT USAGE ON SCHEMA public TO lumen_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lumen_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lumen_app;
--> statement-breakpoint
-- Global identity table: only the auth layer reads it, via the system connection.
-- Tenant code must never be able to enumerate users across tenants.
REVOKE ALL ON TABLE users FROM lumen_app;
--> statement-breakpoint
-- Tables added by future migrations get the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lumen_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lumen_app;
