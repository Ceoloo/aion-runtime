-- ============================================================================
-- AION Data — database privilege grants (least privilege, two-role model)
-- ============================================================================
-- Applied ONCE per environment through the MIGRATION identity (aion_migrator),
-- after aion-data migrations have created the canonical tables. This file is
-- the aion-infra realization of the "grant sketch" documented in
-- aion-data/docs/security.md. It is idempotent and safe to re-run.
--
-- Run automatically by the migrate job/entrypoint after migrations
-- (runtime/src/migrate.ts), or manually via scripts/migrate.sh — see
-- docs/database.md and docs/runbook.md.
--
-- Roles are created by Terraform (google_sql_user); this file only shapes
-- PRIVILEGES. Nothing here encodes business/authorization logic — that is AION
-- Core policy (aion-data/docs/security.md: "Integrity in the DB; authz in Core").
--
-- NOTE (managed providers): the DATABASE-level CONNECT and SCHEMA-level USAGE
-- grants below require the migration role to own (or hold grant option on) the
-- database and the `public` schema. On Cloud SQL the migrator is provisioned
-- with that ownership (it also creates every table, so all TABLE grants below
-- always apply). The per-table DML / append-only controls are the substantive
-- least-privilege boundary and hold regardless of database defaults.
-- ----------------------------------------------------------------------------

-- Fail loudly if the expected roles are absent (Terraform must have run first).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aion_app') THEN
    RAISE EXCEPTION 'role aion_app missing — apply Terraform (database module) first';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aion_migrator') THEN
    RAISE EXCEPTION 'role aion_migrator missing — apply Terraform (database module) first';
  END IF;
END
$$;

-- ── Schema ownership: the migrator owns and may change shape ────────────────
GRANT ALL ON SCHEMA public TO aion_migrator;

-- ── Application role: connect + DML only, NEVER DDL ─────────────────────────
GRANT CONNECT ON DATABASE aion_data TO aion_app;
GRANT USAGE ON SCHEMA public TO aion_app;

-- Read/write on all current tables…
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO aion_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aion_app;

-- …and on future tables the migrator creates, so a new migration does not
-- silently leave the app role without access (default privileges apply to
-- objects created by aion_migrator).
ALTER DEFAULT PRIVILEGES FOR ROLE aion_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO aion_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aion_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aion_app;

-- ── Append-only enforcement at the grant level ──────────────────────────────
-- events and telemetry_records are immutable facts (aion-data/docs/security.md):
-- the app role may INSERT and SELECT but never UPDATE or DELETE history.
REVOKE UPDATE, DELETE ON events            FROM aion_app;
REVOKE UPDATE, DELETE ON telemetry_records FROM aion_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aion_migrator IN SCHEMA public
  REVOKE UPDATE, DELETE ON TABLES FROM aion_app;
-- (The blanket default-privilege revoke above keeps the app role INSERT/SELECT
--  only by default; per-table UPDATE is re-granted explicitly where mutable
--  operational state requires it — runs, missions, approvals, actors, outcomes.)
GRANT UPDATE ON runs, missions, approvals, actors, outcomes TO aion_app;

-- ── Never: the app role gets no schema-modification or role privileges ───────
REVOKE CREATE ON SCHEMA public FROM aion_app;
