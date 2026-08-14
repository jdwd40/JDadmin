-- Dwarf Coins user-administration functions for JDadmin (issue #2).
-- Apply AFTER 001_jdadmin_principal.sql with the Dwarf migration/owner role only:
--   psql -v ON_ERROR_STOP=1 -f 002_jdadmin_user_admin.sql
--
-- What this provides, and why it is safe:
--   * jdadmin_admin_create_user delegates to app_auth.register_user, the app's
--     own registration flow. The engine starter package, identity rows and the
--     registration auth event are created exactly as in self-service signup.
--     JDadmin supplies a pre-computed Argon2id hash; plaintext never reaches
--     the database. No wallet/holdings/ledger rows are written directly.
--   * jdadmin_admin_set_user_disabled toggles app_auth.users.disabled_at, the
--     schema's own access latch that every login/session function honours,
--     and revokes live refresh sessions via the existing admin function.
--     It refuses to disable the calling JDadmin control-plane principal.
-- Both functions are SECURITY DEFINER, re-check public.assert_admin_caller()
-- (transaction-local app.user_id must map to profiles.role='admin'), and are
-- granted to dc_api only.
--
-- Deliberately NOT provided: user deletion. profiles/id anchors cascade into
-- engine-owned wallets, holdings, limit orders and the append-only
-- transactions ledger; Dwarf has no delete-user function and adding one would
-- destroy financial history. Disable is the supported alternative.

BEGIN;

SET search_path TO public, app_auth, pg_catalog;

CREATE OR REPLACE FUNCTION public.jdadmin_admin_create_user(
  p_email text,
  p_display_name text,
  p_password_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, app_auth, pg_catalog
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_email IS NULL OR p_email <> lower(btrim(p_email)) OR length(p_email) > 254 THEN
    RAISE EXCEPTION 'Invalid normalized email';
  END IF;
  IF p_display_name IS NOT NULL
     AND (btrim(p_display_name) = '' OR length(p_display_name) > 80) THEN
    RAISE EXCEPTION 'Invalid display name';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash !~ '^\$argon2id\$' THEN
    RAISE EXCEPTION 'Only Argon2id password hashes are accepted';
  END IF;
  -- The real registration flow: validates, inserts the auth user + identity,
  -- re-points transaction-local app.user_id at the new user, runs the engine
  -- starter package, and records the registration auth event.
  RETURN app_auth.register_user(v_id, p_email, p_display_name, p_password_hash);
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_create_user(text, text, text) IS
  'JDadmin control-plane user creation via app_auth.register_user; Argon2id hashes only, admin caller required.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_create_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_create_user(text, text, text) TO dc_api;

CREATE OR REPLACE FUNCTION public.jdadmin_admin_set_user_disabled(
  p_user_id uuid,
  p_disabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, app_auth, pg_catalog
AS $function$
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_disabled AND p_user_id = public.current_player_id() THEN
    RAISE EXCEPTION 'Refusing to disable the calling admin principal';
  END IF;
  UPDATE app_auth.users
     SET disabled_at = CASE WHEN p_disabled THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_disabled THEN
    -- Kill live refresh sessions so disable takes effect immediately; access
    -- tokens additionally fail on the disabled_at check in verify paths.
    PERFORM app_auth.revoke_user_sessions_admin(p_user_id);
  END IF;
  RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_set_user_disabled(uuid, boolean) IS
  'JDadmin control-plane disable/enable via app_auth.users.disabled_at plus refresh-session revocation.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_set_user_disabled(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_set_user_disabled(uuid, boolean) TO dc_api;

COMMIT;
