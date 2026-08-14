-- Dwarf Coins control-plane principal for JDadmin.
-- Apply with the Dwarf migration/owner role only:
--   psql -v ON_ERROR_STOP=1 -v admin_id='<UUID>' -f 001_jdadmin_principal.sql
-- The UUID must be stored in JDadmin as DWARF_ADMIN_PRINCIPAL_ID.
-- This script never creates a wallet, holdings, starter balance, or login secret.

-- The UUID must be supplied with psql -v admin_id='<UUID>'.

BEGIN;

SELECT pg_catalog.set_config('jdadmin.admin_id', :'admin_id', true);

DO $guard$
DECLARE
  v_id uuid := pg_catalog.current_setting('jdadmin.admin_id')::uuid;
  v_existing_email text;
BEGIN
  SELECT email INTO v_existing_email FROM app_auth.users WHERE id = v_id;
  IF v_existing_email IS NOT NULL AND v_existing_email <> 'jdadmin-dwarf-control@invalid.local' THEN
    RAISE EXCEPTION 'Refusing to reuse principal UUID belonging to %', v_existing_email;
  END IF;
END;
$guard$;

INSERT INTO app_auth.users (
  id, email, display_name, confirmed_at, disabled_at,
  password_hash, legacy_password_hash, password_reset_required
)
VALUES (
  :'admin_id'::uuid,
  'jdadmin-dwarf-control@invalid.local',
  'JDadmin Dwarf control plane',
  now(), now(),
  NULL, NULL, true
)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    confirmed_at = COALESCE(app_auth.users.confirmed_at, EXCLUDED.confirmed_at),
    disabled_at = COALESCE(app_auth.users.disabled_at, EXCLUDED.disabled_at),
    password_hash = NULL,
    legacy_password_hash = NULL,
    password_reset_required = true,
    updated_at = now();

INSERT INTO public.profiles (id, display_name, role)
VALUES (:'admin_id'::uuid, 'JDadmin Dwarf control plane', 'admin')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    role = 'admin',
    updated_at = now();

SET search_path TO public, app_auth, pg_catalog;

CREATE OR REPLACE FUNCTION public.jdadmin_admin_reset_password(p_user_id uuid, p_password_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, app_auth, pg_catalog
AS $function$
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_password_hash IS NULL OR p_password_hash !~ '^\\$argon2id\\$' THEN
    RAISE EXCEPTION 'Only Argon2id password hashes are accepted';
  END IF;
  UPDATE app_auth.users
     SET password_hash = p_password_hash,
         legacy_password_hash = NULL,
         password_changed_at = now(),
         password_reset_required = false,
         updated_at = now()
   WHERE id = p_user_id;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.jdadmin_admin_reset_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_reset_password(uuid, text) TO dc_api;

GRANT USAGE ON SCHEMA app_auth TO dc_api;
GRANT SELECT (id, email, display_name, confirmed_at, disabled_at, created_at, updated_at)
  ON app_auth.users TO dc_api;

COMMIT;
