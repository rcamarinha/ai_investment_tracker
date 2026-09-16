/**
 * Pure rules for admin invitations.
 *
 * Shared by the admin-invite edge function, which runs on Deno, and by the test
 * suite, which runs on Node. That is why it has no imports and does no I/O: the
 * function makes the calls, and this module decides what they mean. The edge
 * runtime cannot be exercised from the suite, so every judgement worth testing
 * lives here rather than inside the function.
 */

const EMAIL_MAX = 254;
const present = v => v !== null && v !== undefined && v !== '';

/**
 * Normalise an email typed into the invite form.
 *
 * Deliberately loose. The auth server is the real validator; this only stops an
 * obvious typo from spending one of the two auth emails an hour that Supabase's
 * built-in email service allows.
 *
 * @returns {{ok: true, email: string} | {ok: false, reason: string}}
 */
export function normalizeInviteEmail(raw) {
    const email = String(raw ?? '').trim().toLowerCase();
    if (!email) return { ok: false, reason: 'Enter an email address.' };
    if (email.length > EMAIL_MAX) return { ok: false, reason: 'That email address is too long.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, reason: 'That does not look like an email address.' };
    }
    return { ok: true, email };
}

/**
 * Where a person stands, read from the auth user record itself.
 *
 *   pending   invited, and has never confirmed or signed in
 *   accepted  invited, and has since confirmed or signed in
 *   member    an account that did not come from an invitation
 *
 * Reading this from auth.users is what lets invitations need no table of their
 * own, and so no migration.
 */
export function inviteStatus(user) {
    if (!user) return 'unknown';
    const joined = present(user.email_confirmed_at) || present(user.last_sign_in_at);
    if (present(user.invited_at)) return joined ? 'accepted' : 'pending';
    return 'member';
}

/**
 * Only an invitation nobody has accepted may be revoked, and never the caller's
 * own account. Revoking deletes the unconfirmed user, which is what makes the
 * emailed link stop working, so this is the line between withdrawing an
 * invitation and deleting someone's account.
 */
export function canRevoke(user, callerId) {
    return !!user && present(user.id) && user.id !== callerId && inviteStatus(user) === 'pending';
}

/**
 * Where the invitation link should land: the hub, on an allowed origin.
 *
 * Never taken from the request body. An origin outside the allow-list falls back
 * to the first allowed one, so a caller cannot point an invitation at a site of
 * their choosing. The hub is the single page that recognises an invite link.
 */
export function pickRedirect(origin, allowedOrigins) {
    const allowed = Array.isArray(allowedOrigins) ? allowedOrigins.filter(present) : [];
    const base = allowed.includes(origin) ? origin : allowed[0];
    return base ? `${base}/` : null;
}

/**
 * The admin page's list: pending invitations first, newest first within each.
 * Carries only what the page shows — no metadata, no tokens, no app data.
 */
export function summarizeUsers(users) {
    const order = { pending: 0, accepted: 1, member: 2, unknown: 3 };
    return (users || [])
        .filter(u => u && present(u.id))
        .map(u => ({
            id: u.id,
            email: u.email ?? null,
            status: inviteStatus(u),
            invitedAt: u.invited_at ?? null,
            confirmedAt: u.email_confirmed_at ?? null,
            lastSignInAt: u.last_sign_in_at ?? null,
            createdAt: u.created_at ?? null,
        }))
        .sort((a, b) =>
            (order[a.status] - order[b.status]) ||
            String(b.invitedAt || b.createdAt || '').localeCompare(String(a.invitedAt || a.createdAt || '')));
}
