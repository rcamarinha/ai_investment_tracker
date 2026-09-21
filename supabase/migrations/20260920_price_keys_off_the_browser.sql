-- Migration: the shared price-API keys stop being readable from the browser.
--
-- Plan P3 part 2. Finnhub, FMP and Alpha Vantage keys sat in app_config under a
-- policy letting EVERY signed-in account read them, and the portfolio page
-- copied them into each browser's localStorage. With invite-only accounts,
-- every invitee could read them. They now live only as secrets of the
-- market-data edge function, which calls the providers for the browser.
--
-- This removes both halves of the old route:
--   1. the policy that let any authenticated user read the key rows, and
--   2. the key rows themselves. Dropping the policy alone is not enough:
--      "Admin users can read config" stays, so every admin's browser would
--      keep receiving the keys.
--
-- ORDER — chosen to keep the old keys exposed for the shortest time:
--   1. Create NEW keys at each provider (Finnhub, FMP, Alpha Vantage).
--   2. `supabase secrets set` the NEW values, and deploy market-data.
--   3. Run this migration straight away.
--   4. Ship the client.
--   5. Make sure the OLD keys are revoked at each provider.
-- Until step 3, any account can read the old keys with a direct REST call — the
-- new client does not change that, which is why this runs before it ships. The
-- new keys never touch app_config. Between steps 3 and 4 the live client finds
-- no key rows and prices through the keyless proxy and AI resolver: slower for
-- a few minutes, nothing lost.
--
-- Re-runnable: DROP POLICY IF EXISTS, and the DELETE matches nothing twice.
-- Rollback: supabase/maintenance/rollback-20260920-price-keys.sql is
-- intentionally a no-op — restoring the policy would recreate the exposure.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Authenticated users can read pricing keys" ON public.app_config;

DELETE FROM public.app_config
WHERE key IN ('finnhubKey', 'fmpKey', 'alphaVantageKey');

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- AFTER, read-only:
--   1. No key rows remain (expect zero rows):
--        SELECT key FROM app_config WHERE key IN ('finnhubKey', 'fmpKey', 'alphaVantageKey');
--   2. Only the admin read policy remains on app_config:
--        SELECT policyname, cmd FROM pg_policies WHERE tablename = 'app_config';
-- ════════════════════════════════════════════════════════════════════════════
