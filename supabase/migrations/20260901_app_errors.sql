-- ============================================
-- app_errors — client-side error reporting
-- ============================================
-- Run in the Supabase SQL Editor. Safe to run more than once.
--
-- WHY: the app had exactly one global error handler (portfolio.html), which
-- alert()ed the raw message and then swallowed it. Everything else surfaced
-- only as console.error — invisible unless a user happens to have DevTools
-- open. With a handful of users you find out by being told; the intent is to
-- grow, and "the import looked fine but logged three errors" is precisely the
-- shape of problem that stays hidden.
--
-- PRIVACY: this table must never accumulate financial data. Error messages can
-- quote transaction descriptions, so the client truncates and redacts before
-- sending, and `context` is a small allow-listed object — never a row, never a
-- statement, never a file's contents.
-- ============================================

CREATE TABLE IF NOT EXISTS app_errors (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    page         TEXT NOT NULL,                      -- 'spend', 'wine', ...
    kind         TEXT NOT NULL DEFAULT 'error'
                 CHECK (kind IN ('error', 'rejection', 'handled')),
    message      TEXT NOT NULL,
    stack        TEXT,
    source       TEXT,                               -- file that threw
    line         INTEGER,
    col          INTEGER,
    app_version  TEXT,
    user_agent   TEXT,
    context      JSONB DEFAULT '{}'::jsonb           -- allow-listed keys only
);

CREATE INDEX IF NOT EXISTS idx_app_errors_user_id ON app_errors(user_id);
CREATE INDEX IF NOT EXISTS idx_app_errors_created ON app_errors(created_at DESC);

-- RLS: own rows only, and INSERT-only from the client. Nothing in the app ever
-- updates or deletes an error report, so those policies are deliberately absent.
DO $$
BEGIN
    EXECUTE 'ALTER TABLE app_errors ENABLE ROW LEVEL SECURITY';

    DROP POLICY IF EXISTS "Users can insert own app_errors" ON app_errors;
    CREATE POLICY "Users can insert own app_errors"
        ON app_errors FOR INSERT WITH CHECK (auth.uid() = user_id);

    DROP POLICY IF EXISTS "Users can view own app_errors" ON app_errors;
    CREATE POLICY "Users can view own app_errors"
        ON app_errors FOR SELECT USING (auth.uid() = user_id);
END $$;
