-- Admin role: single source of truth = membership in admin_users.
--
-- Previously the client read the `adminEmails` app_config row to decide admin
-- status, but that row is only readable by admins (RLS), so a non-admin always
-- fell through to "user" and provisioning required TWO coordinated edits
-- (admin_users row + adminEmails value). checkUserRole() now queries admin_users
-- directly, so it needs a per-user SELECT policy: each user may read ONLY their
-- own row. This proves membership without letting anyone enumerate all admins.

CREATE POLICY "Users can read their own admin row"
    ON admin_users FOR SELECT
    USING (auth.uid() = user_id);

-- The `adminEmails` app_config row is now unused (checkUserRole no longer reads
-- it). Kept in place harmlessly; remove it if you want a clean config table:
--   DELETE FROM app_config WHERE key = 'adminEmails';

-- To make a user an admin (single edit, run as service role in the SQL editor):
--   INSERT INTO admin_users (user_id)
--   SELECT id FROM auth.users WHERE email = 'you@example.com'
--   ON CONFLICT (user_id) DO NOTHING;
