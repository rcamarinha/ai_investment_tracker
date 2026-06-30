-- Remember the ticker that actually returns a price for an asset (e.g. an EU
-- exchange-suffix remap like AEU.FRK → AEU.DE, or a US ADR), so future price
-- refreshes fetch it directly instead of re-running the alternative search.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS pricing_ticker TEXT;
