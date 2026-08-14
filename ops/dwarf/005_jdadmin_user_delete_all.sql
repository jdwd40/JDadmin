-- Dwarf Coins delete-ALL-users function for JDadmin (issue #15).
-- Apply AFTER 001_jdadmin_principal.sql … 004_jdadmin_user_delete.sql with the
-- Dwarf migration/owner role only:
--   psql -v ON_ERROR_STOP=1 -f 005_jdadmin_user_delete_all.sql
--
-- Scope (the exact exclusion): every row in app_auth.users EXCEPT the calling
-- JDadmin control-plane principal (transaction-local app.user_id, i.e. the UUID
-- stored as DWARF_ADMIN_PRINCIPAL_ID). The principal is the identity required
-- to call these SECURITY DEFINER functions; deleting it would lock out the
-- admin control plane, so it is structurally excluded — the function derives
-- the exclusion from the caller identity, never from a caller-supplied id.
-- The principal row itself is left completely untouched, preserving its
-- provisioned state (disabled, passwordless, password_reset_required=true).
--
-- RISK — THIS OPERATION IS IRREVERSIBLE. Deleting app_auth.users cascades
-- through the verified FK graph (database/baseline/006_relational_objects.sql
-- as re-pointed by backend/migrations/1784050200000_install_portable_game_engine.ts):
--   * ON DELETE CASCADE: profiles, wallets, portfolio_holdings, transactions
--     ledger, limit_orders, mining_jobs, player_action_cooldowns,
--     leaderboard_cache, app_auth.identities, refresh_sessions (→
--     refresh_session_tokens), password_reset_tokens. Every deleted user's
--     history and financial records are destroyed.
--   * ON DELETE SET NULL: public_feed.user_id and app_auth.auth_events.user_id
--     survive anonymized.
-- The product owner explicitly accepts this irreversible destruction of user
-- history/financial records. There is no undo and no soft-delete copy; take a
-- database backup before running this against a database you care about.
--
-- What the function does, atomically in the caller's transaction:
--   1. Re-checks public.assert_admin_caller() (transaction-local app.user_id
--      must map to profiles.role='admin').
--   2. Counts the in-scope users (all except the caller) and refuses unless
--      p_expected_count matches exactly — the exact-count confirmation is
--      re-validated database-side, so a stale UI count aborts with no delete.
--   3. Counts every dependent row in scope BEFORE deleting (truthful counts).
--   4. Records a redacted app-side auth event ('admin_deleted_all_users',
--      attributed to the calling admin; metadata carries only the scope label,
--      the excluded principal UUID, and counts — never emails, display names,
--      or hashes).
--   5. DELETEs every app_auth.users row except the caller's; the verified FK
--      cascade removes the whole graph. Any RESTRICT FK added later aborts the
--      whole transaction with a truthful error instead of a partial delete.
--
-- Grants: EXECUTE to dc_api only. No BYPASSRLS, no broad table grants, no
-- arbitrary SQL/table names.

BEGIN;

SET search_path TO public, app_auth, pg_catalog;

CREATE OR REPLACE FUNCTION public.jdadmin_admin_delete_all_users(p_expected_count bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, app_auth, pg_catalog
AS $function$
DECLARE
  v_admin uuid := public.current_player_id();
  v_inscope bigint;
  v_counts jsonb;
BEGIN
  PERFORM public.assert_admin_caller();

  -- In-scope = every app user except the calling control-plane principal.
  SELECT count(*) INTO v_inscope FROM app_auth.users WHERE id <> v_admin;

  IF p_expected_count IS NULL OR p_expected_count <> v_inscope THEN
    RAISE EXCEPTION 'Count confirmation mismatch: % users are in scope (all users except the control-plane principal); re-check the scope and confirm the exact total.', v_inscope;
  END IF;

  -- Truthful pre-delete counts of everything the cascade removes/anonymizes
  -- for the in-scope users.
  SELECT jsonb_build_object(
    'wallets', (SELECT count(*) FROM public.wallets w WHERE w.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'portfolio_holdings', (SELECT count(*) FROM public.portfolio_holdings h WHERE h.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'transactions', (SELECT count(*) FROM public.transactions t WHERE t.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'limit_orders', (SELECT count(*) FROM public.limit_orders o WHERE o.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'mining_jobs', (SELECT count(*) FROM public.mining_jobs j WHERE j.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'player_action_cooldowns', (SELECT count(*) FROM public.player_action_cooldowns c WHERE c.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'leaderboard_cache', (SELECT count(*) FROM public.leaderboard_cache l WHERE l.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'public_feed_anonymized', (SELECT count(*) FROM public.public_feed f WHERE f.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'identities', (SELECT count(*) FROM app_auth.identities i WHERE i.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'refresh_sessions', (SELECT count(*) FROM app_auth.refresh_sessions s WHERE s.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin)),
    'password_reset_tokens', (SELECT count(*) FROM app_auth.password_reset_tokens r WHERE r.user_id IN (SELECT id FROM app_auth.users WHERE id <> v_admin))
  ) INTO v_counts;

  -- Redacted app-side audit: attributed to the calling admin (whose row is
  -- excluded from the delete, so the attribution survives). Metadata carries
  -- only the scope label, the excluded principal UUID, and counts.
  INSERT INTO app_auth.auth_events (user_id, event_type, metadata)
  VALUES (
    v_admin,
    'admin_deleted_all_users',
    jsonb_build_object(
      'scope', 'all_users_except_control_principal',
      'excluded_user_id', v_admin,
      'deleted_users', v_inscope,
      'related_counts', v_counts
    )
  );

  -- One cascading delete of the whole in-scope graph; atomic or not at all.
  DELETE FROM app_auth.users WHERE id <> v_admin;

  RETURN jsonb_build_object('deleted_users', v_inscope, 'related_counts', v_counts);
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_delete_all_users(bigint) IS
  'JDadmin control-plane IRREVERSIBLE delete of every Dwarf user except the calling control-plane principal: cascades the verified FK graph (profiles, wallets, holdings, ledger, orders, sessions), anonymizes feed/auth-event rows, requires an exact in-scope count match, admin caller required.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_delete_all_users(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_delete_all_users(bigint) TO dc_api;

COMMIT;
