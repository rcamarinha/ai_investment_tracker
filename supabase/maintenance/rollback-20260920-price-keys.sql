-- Rollback for supabase/migrations/20260920_price_keys_off_the_browser.sql
--
-- Deliberately does NOT restore the policy "Authenticated users can read
-- pricing keys". That policy let every signed-in account read the shared price
-- keys, and restoring it only takes someone later re-inserting a key row "to fix
-- pricing" to expose the keys to every account again.
--
-- Nothing needs it back: with the key rows gone, an older client simply prices
-- through the keyless proxy and the AI resolver, with or without the policy.
-- The keys live in the market-data function's secrets now; to change one, use
--   npx supabase secrets set FMP_API_KEY=…
--
-- So this is intentionally a no-op, kept so the migration harness can check the
-- migration re-applies cleanly after a "rollback" (tests/migrations.test.js).

SELECT 'rollback-20260920: intentionally a no-op — see the header' AS note;
