-- Dwarf Coins user-deletion function for JDadmin (issue #11).
-- Apply AFTER 001_jdadmin_principal.sql, 002_jdadmin_user_admin.sql and
-- 003_jdadmin_price_history_admin.sql with the Dwarf migration/owner role
-- only:
--   psql -v ON_ERROR_STOP=1 -f 004_jdadmin_user_delete.sql
--
-- Why hard delete is now possible (verified against the real self-hosted
-- schema — database/baseline/006_relational_objects.sql as re-pointed by
-- backend/migrations/1784050200000_install_portable_game_engine.ts, which
-- rewrites REFERENCES auth.users(id) -> app_auth.users(id)):
--   * profiles.id -> app_auth.users(id) ON DELETE CASCADE, and every FK that
--     references profiles(id) is ON DELETE CASCADE: wallets,
--     portfolio_holdings, transactions, limit_orders, mining_jobs,
--     player_action_cooldowns, leaderboard_cache. public_feed.user_id is
--     ON DELETE SET NULL (feed rows survive anonymized).
--   * app_auth.identities / refresh_sessions (-> refresh_session_tokens) /
--     password_reset_tokens are ON DELETE CASCADE; app_auth.auth_events.user_id
--     is ON DELETE SET NULL, so the append-only auth audit survives with the
--     principal anonymized.
--   * No DELETE trigger exists on any of these tables (only UPDATE/INSERT
--     triggers), so the cascade cannot be blocked by a trigger.
-- The product owner explicitly accepts destroying the deleted user's related
-- history/financial records, so deleting app_auth.users removes the whole
-- graph atomically inside the caller's transaction.
--
-- What the function does, in one transaction:
--   1. Re-checks public.assert_admin_caller() (transaction-local app.user_id
--      must map to profiles.role='admin').
--   2. Refuses to delete the calling control-plane principal itself.
--   3. Counts every dependent row BEFORE deleting, so the returned counts are
--      truthful.
--   4. Records a redacted app-side auth event (event_type
--      'admin_deleted_user', attributed to the calling admin, metadata carries
--      only the deleted UUID + counts — never email, display name or hashes).
--   5. DELETEs the app_auth.users row; the verified FK cascade removes the
--      profile and all dependent rows. Any RESTRICT FK added later aborts the
--      whole transaction with a truthful error instead of a partial delete.
--
-- Deliberately NOT provided: delete-all-users. The calling control-plane
-- principal is itself a row in that scope and the self-delete guard makes an
-- honest full delete-all impossible; wiping every engine user is not a
-- Dwarf-supported operation.
--
-- Grants: EXECUTE to dc_api only. No BYPASSRLS, no broad table grants.

BEGIN;

SET search_path TO public, app_auth, pg_catalog;

CREATE OR REPLACE FUNCTION public.jdadmin_admin_delete_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, app_auth, pg_catalog
AS $function$
DECLARE
  v_admin uuid := public.current_player_id();
  v_counts jsonb;
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_user_id = v_admin THEN
    RAISE EXCEPTION 'Refusing to delete the calling admin principal';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  -- Truthful pre-delete counts of everything the cascade removes/anonymizes.
  SELECT jsonb_build_object(
    'wallets', (SELECT count(*) FROM public.wallets WHERE user_id = p_user_id),
    'portfolio_holdings', (SELECT count(*) FROM public.portfolio_holdings WHERE user_id = p_user_id),
    'transactions', (SELECT count(*) FROM public.transactions WHERE user_id = p_user_id),
    'limit_orders', (SELECT count(*) FROM public.limit_orders WHERE user_id = p_user_id),
    'mining_jobs', (SELECT count(*) FROM public.mining_jobs WHERE user_id = p_user_id),
    'player_action_cooldowns', (SELECT count(*) FROM public.player_action_cooldowns WHERE user_id = p_user_id),
    'leaderboard_cache', (SELECT count(*) FROM public.leaderboard_cache WHERE user_id = p_user_id),
    'public_feed_anonymized', (SELECT count(*) FROM public.public_feed WHERE user_id = p_user_id),
    'identities', (SELECT count(*) FROM app_auth.identities WHERE user_id = p_user_id),
    'refresh_sessions', (SELECT count(*) FROM app_auth.refresh_sessions WHERE user_id = p_user_id),
    'password_reset_tokens', (SELECT count(*) FROM app_auth.password_reset_tokens WHERE user_id = p_user_id)
  ) INTO v_counts;

  -- Redacted app-side audit: attributed to the calling admin; the metadata
  -- carries only the deleted UUID and row counts (no email/display name/hash).
  INSERT INTO app_auth.auth_events (user_id, event_type, metadata)
  VALUES (
    v_admin,
    'admin_deleted_user',
    jsonb_build_object('deleted_user_id', p_user_id, 'related_counts', v_counts)
  );

  -- One cascading delete; the whole graph goes atomically or not at all.
  DELETE FROM app_auth.users WHERE id = p_user_id;

  RETURN v_counts;
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_delete_user(uuid) IS
  'JDadmin control-plane hard delete of one user: cascades the verified FK graph (profile, wallet, holdings, ledger rows, orders, sessions), anonymizes feed/auth-event rows, refuses self-delete, admin caller required.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_delete_user(uuid) TO dc_api;

COMMIT;
