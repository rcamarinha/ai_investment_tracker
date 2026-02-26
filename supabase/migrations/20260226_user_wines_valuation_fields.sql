-- Migration: add estimated_value_usd, confidence, valuation_sources to user_wines
-- These fields were added in the v1.2.0 valuation improvement but were missing
-- from the DB schema, causing them to be lost on page reload.

ALTER TABLE user_wines
    ADD COLUMN IF NOT EXISTS estimated_value_usd NUMERIC  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS confidence          TEXT     DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS valuation_sources   TEXT     DEFAULT NULL;
