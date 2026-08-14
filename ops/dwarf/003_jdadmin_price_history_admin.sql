-- Dwarf Coins price-history administration functions for JDadmin (issue #10).
-- Apply AFTER 001_jdadmin_principal.sql and 002_jdadmin_user_admin.sql with
-- the Dwarf migration/owner role only:
--   psql -v ON_ERROR_STOP=1 -f 003_jdadmin_price_history_admin.sql
--
-- What this provides, and why it is safe:
--   * Deleting detailed price-history snapshots is an operation Dwarf itself
--     performs: public.prune_old_data() deletes aged price_history rows as
--     part of its scheduled retention sweep. These wrappers expose the same
--     class of delete to the JDadmin control plane (individual record,
--     filtered range, and confirmed delete-all) without touching any
--     engine-owned table. Long-term OHLC aggregates
--     (public.price_history_aggregates) and the transactions ledger are
--     deliberately NOT touched.
--   * Every function is SECURITY DEFINER and begins with
--     public.assert_admin_caller(): the transaction-local app.user_id must
--     map to profiles.role='admin'. No BYPASSRLS, no broad table grants —
--     dc_api receives EXECUTE on these functions only.
--   * jdadmin_admin_delete_price_history_range refuses an unfiltered call;
--     unfiltered deletion only exists as the separate, explicitly confirmed
--     reset function.
--
-- Deliberately NOT provided: deletion from price_history_aggregates,
-- transactions, or any other engine/ledger table.

BEGIN;

SET search_path TO public, app_auth, pg_catalog;

-- Individual snapshot delete. Returns true when a row was removed.
CREATE OR REPLACE FUNCTION public.jdadmin_admin_delete_price_point(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_catalog
AS $function$
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'price history id required';
  END IF;
  DELETE FROM public.price_history WHERE id = p_id;
  RETURN FOUND;
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_delete_price_point(uuid) IS
  'JDadmin control-plane delete of one price-history snapshot; admin caller required.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_delete_price_point(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_delete_price_point(uuid) TO dc_api;

-- Filtered range delete. At least one filter is mandatory so a caller can
-- never wipe the whole table through the "range" path by accident.
CREATE OR REPLACE FUNCTION public.jdadmin_admin_delete_price_history_range(
  p_gem_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_catalog
AS $function$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.assert_admin_caller();
  IF p_gem_id IS NULL AND p_from IS NULL AND p_to IS NULL THEN
    RAISE EXCEPTION 'A filter (gem or date range) is required; use the reset function for delete-all';
  END IF;
  DELETE FROM public.price_history
   WHERE (p_gem_id IS NULL OR gem_id = p_gem_id)
     AND (p_from IS NULL OR recorded_at >= p_from)
     AND (p_to IS NULL OR recorded_at <= p_to);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_delete_price_history_range(uuid, timestamptz, timestamptz) IS
  'JDadmin control-plane filtered price-history delete; at least one filter required, admin caller required.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_delete_price_history_range(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_delete_price_history_range(uuid, timestamptz, timestamptz) TO dc_api;

-- Confirmed delete-all, optionally scoped to one gem. JDadmin gates this
-- behind an exact-row-count confirmation before calling it.
CREATE OR REPLACE FUNCTION public.jdadmin_admin_reset_price_history(p_gem_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_catalog
AS $function$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.assert_admin_caller();
  DELETE FROM public.price_history
   WHERE (p_gem_id IS NULL OR gem_id = p_gem_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.jdadmin_admin_reset_price_history(uuid) IS
  'JDadmin control-plane price-history delete-all (optionally per gem); admin caller required.';

REVOKE ALL ON FUNCTION public.jdadmin_admin_reset_price_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jdadmin_admin_reset_price_history(uuid) TO dc_api;

COMMIT;
