import { describe, it, expect } from 'vitest';
import {
    normalizeInviteEmail, inviteStatus, canRevoke, pickRedirect, summarizeUsers,
} from '../supabase/functions/_shared/invite-core.js';

/**
 * The decisions behind admin invitations.
 *
 * These run inside the admin-invite edge function, which the suite cannot
 * reach, so the judgements live in a pure module and are tested here. The one
 * that matters most is canRevoke: revoking deletes a user, so it is the line
 * between withdrawing an invitation and deleting somebody's account.
 */

const ME = 'admin-id';
const pending = { id: 'p1', email: 'new@example.com', invited_at: '2026-09-15T10:00:00Z', email_confirmed_at: null, last_sign_in_at: null };
const accepted = { id: 'a1', email: 'joined@example.com', invited_at: '2026-09-01T10:00:00Z', email_confirmed_at: '2026-09-02T10:00:00Z', last_sign_in_at: '2026-09-02T10:05:00Z' };
const member = { id: 'm1', email: 'owner@example.com', invited_at: null, email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-09-14T09:00:00Z', created_at: '2026-01-01T00:00:00Z' };

describe('normalizeInviteEmail', () => {
    it('trims and lower-cases a valid address', () => {
        expect(normalizeInviteEmail('  Jane.Doe@Example.COM ')).toEqual({ ok: true, email: 'jane.doe@example.com' });
    });

    it('refuses blank input with a reason, never throws', () => {
        for (const raw of ['', '   ', null, undefined]) {
            const r = normalizeInviteEmail(raw);
            expect(r.ok).toBe(false);
            expect(r.reason).toBeTruthy();
        }
    });

    it('refuses things that are not email addresses', () => {
        for (const raw of ['jane', 'jane@', '@example.com', 'jane@example', 'jane doe@example.com', 'a@b@c.com']) {
            expect(normalizeInviteEmail(raw).ok, raw).toBe(false);
        }
    });

    it('refuses an address longer than the protocol allows', () => {
        expect(normalizeInviteEmail(`${'a'.repeat(250)}@example.com`).ok).toBe(false);
    });
});

describe('inviteStatus', () => {
    it('reads an unaccepted invitation as pending', () => expect(inviteStatus(pending)).toBe('pending'));
    it('reads a confirmed invitation as accepted', () => expect(inviteStatus(accepted)).toBe('accepted'));
    it('reads an account that was never invited as a member', () => expect(inviteStatus(member)).toBe('member'));

    it('counts a sign-in as joining even without a confirmation timestamp', () => {
        expect(inviteStatus({ ...pending, last_sign_in_at: '2026-09-15T11:00:00Z' })).toBe('accepted');
    });

    it('treats empty strings as absent, not as a timestamp', () => {
        expect(inviteStatus({ ...pending, email_confirmed_at: '', last_sign_in_at: '' })).toBe('pending');
    });

    it('does not guess about a missing record', () => expect(inviteStatus(null)).toBe('unknown'));
});

describe('canRevoke', () => {
    it('allows withdrawing an invitation nobody has accepted', () => {
        expect(canRevoke(pending, ME)).toBe(true);
    });

    it('never deletes an account that has joined', () => {
        expect(canRevoke(accepted, ME)).toBe(false);
    });

    it('never deletes an account that did not come from an invitation', () => {
        expect(canRevoke(member, ME)).toBe(false);
    });

    it('never lets an admin revoke themselves, even in an odd state', () => {
        expect(canRevoke({ ...pending, id: ME }, ME)).toBe(false);
    });

    it('refuses a missing or id-less record', () => {
        expect(canRevoke(null, ME)).toBe(false);
        expect(canRevoke({ ...pending, id: '' }, ME)).toBe(false);
    });
});

describe('pickRedirect', () => {
    const ALLOWED = ['https://cacoventures.com', 'https://www.cacoventures.com'];

    it('lands on the hub of an allowed origin', () => {
        expect(pickRedirect('https://www.cacoventures.com', ALLOWED)).toBe('https://www.cacoventures.com/');
    });

    it('never points an invitation at an origin outside the allow-list', () => {
        expect(pickRedirect('https://evil.example', ALLOWED)).toBe('https://cacoventures.com/');
        expect(pickRedirect('', ALLOWED)).toBe('https://cacoventures.com/');
    });

    it('returns nothing rather than inventing a destination', () => {
        expect(pickRedirect('https://cacoventures.com', [])).toBeNull();
    });
});

describe('summarizeUsers', () => {
    it('puts pending invitations first', () => {
        const out = summarizeUsers([member, accepted, pending]);
        expect(out.map(p => p.status)).toEqual(['pending', 'accepted', 'member']);
    });

    it('carries only what the admin page shows', () => {
        const [p] = summarizeUsers([{ ...pending, app_metadata: { secret: 1 }, user_metadata: { x: 1 } }]);
        expect(Object.keys(p).sort()).toEqual(['confirmedAt', 'createdAt', 'email', 'id', 'invitedAt', 'lastSignInAt', 'status']);
    });

    it('orders newest first within a status', () => {
        const older = { ...pending, id: 'p0', invited_at: '2026-09-01T00:00:00Z' };
        expect(summarizeUsers([older, pending]).map(p => p.id)).toEqual(['p1', 'p0']);
    });

    it('skips records with no id and survives nothing at all', () => {
        expect(summarizeUsers([{ email: 'x@example.com' }, null])).toEqual([]);
        expect(summarizeUsers(undefined)).toEqual([]);
    });
});
