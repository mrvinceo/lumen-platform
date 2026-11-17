-- Better Auth's global tables hold sessions, OAuth tokens and password hashes. Default privileges from
-- migration 0002 granted them to lumen_app; tenant-scoped code must never be able to read them.
REVOKE ALL ON TABLE sessions, accounts, verifications FROM lumen_app;
