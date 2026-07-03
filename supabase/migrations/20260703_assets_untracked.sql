-- Persist the "kept at cost" (untracked) flag so a deliberate keep-at-cost
-- choice survives reloads, and can be reliably cleared when the user re-enables
-- pricing. Previously `untracked` lived only in memory, so the choice was lost
-- on reload (inconsistent) and there was no durable record to recover from.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS untracked BOOLEAN DEFAULT FALSE;
