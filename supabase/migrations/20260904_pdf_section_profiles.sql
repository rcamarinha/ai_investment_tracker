-- A PDF profile records the SECTIONS a bank prints and what each one is for,
-- which is the PDF equivalent of the column mapping a CSV profile stores.
--
-- Not folded into column_map: that column is documented as the CSV column
-- mapping, and overloading it would make a future reader of either feature
-- wrong about the other.
--
-- Idempotent: safe to run more than once.
ALTER TABLE spend_bank_profiles
    ADD COLUMN IF NOT EXISTS section_map JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN spend_bank_profiles.section_map IS
    'For format_kind = pdf: the confirmed sections of this bank''s statement — heading text, role (statement/detail/skip) and, for card sections, the account they route to. Keyed by heading signature, so a bank redesigning its statement fails to match and is re-confirmed rather than silently replayed.';
