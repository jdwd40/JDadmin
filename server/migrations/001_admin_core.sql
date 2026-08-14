-- Admin control-plane schema. This schema belongs to the Universal Admin app
-- itself; it is additive and does not modify Coins or Dwarf Coins schemas.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_lower_idx
  ON admin_users (lower(username));

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS admin_sessions_user_id_idx ON admin_sessions (user_id);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions (expires_at);

-- Append-only audit log. UPDATE/DELETE are blocked at the database level.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  actor_username text NOT NULL,
  app_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  previous jsonb,
  new jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_app_idx ON admin_audit_log (app_id, created_at DESC);

CREATE OR REPLACE FUNCTION admin_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_log_no_update ON admin_audit_log;
CREATE TRIGGER admin_audit_log_no_update
  BEFORE UPDATE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();

DROP TRIGGER IF EXISTS admin_audit_log_no_delete ON admin_audit_log;
CREATE TRIGGER admin_audit_log_no_delete
  BEFORE DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();
