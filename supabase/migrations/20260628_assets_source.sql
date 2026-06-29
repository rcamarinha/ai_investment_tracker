-- Track the provenance of an ISIN→ticker mapping on the assets table.
-- 'user' = manually entered by the user when auto-resolution failed; null/'api'
-- = resolved automatically. Lets a wrong manual mapping be identified/reversed.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source TEXT;
