-- The deployed transactions table carried a CHECK constraint limiting `type`
-- to buy/sell. The ledger now uses the full taxonomy (dividend, fee, split,
-- isin_change), so that constraint rejects the new rows (error 23514) and
-- aborts the entire transaction save. Replace it with a permissive allow-list
-- that still catches typos but accepts every current type.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('buy', 'sell', 'dividend', 'fee', 'split', 'isin_change'));
