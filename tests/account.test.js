import { describe, it, expect } from 'vitest';
import { createAccountActions } from '../services/account.js';

/**
 * The shared account actions, over a fake Supabase client.
 *
 * Five pages each carry their own copy of these handlers, and the copies have
 * drifted: four of them dereference a missing client and throw. This module is
 * the one every page should use, so what it promises is pinned here — above
 * all, that it never throws and always returns something a page can show.
 */

function fakeClient({ error = null } = {}) {
    const calls = [];
    const record = (name) => async (...args) => { calls.push([name, ...args]); return { error }; };
    return {
        calls,
        client: {
            auth: {
                signInWithPassword: record('signInWithPassword'),
                signOut: record('signOut'),
                signInWithOAuth: record('signInWithOAuth'),
                resetPasswordForEmail: record('resetPasswordForEmail'),
                updateUser: record('updateUser'),
            },
        },
    };
}

const actionsFor = (client, redirectTo = () => 'https://cacoventures.com/') =>
    createAccountActions({ getClient: () => client, redirectTo });

describe('createAccountActions without a client', () => {
    it('never throws, and says sign-in is not ready', async () => {
        const a = createAccountActions({ getClient: () => null });
        for (const r of await Promise.all([a.login('x@y.z', 'secret1'), a.logout(), a.googleLogin(), a.forgotPassword('x@y.z'), a.setPassword('secret1', 'secret1')])) {
            expect(r.ok).toBe(false);
            expect(r.message).toMatch(/not ready/i);
        }
    });

    it('survives being created with no options at all', async () => {
        const r = await createAccountActions().login('x@y.z', 'secret1');
        expect(r.ok).toBe(false);
    });
});

describe('login', () => {
    it('trims the email and signs in', async () => {
        const { client, calls } = fakeClient();
        const r = await actionsFor(client).login('  jane@example.com ', 'secret1');
        expect(r).toEqual({ ok: true });
        expect(calls).toEqual([['signInWithPassword', { email: 'jane@example.com', password: 'secret1' }]]);
    });

    it('asks for both fields before calling the server', async () => {
        const { client, calls } = fakeClient();
        expect((await actionsFor(client).login('', 'secret1')).ok).toBe(false);
        expect((await actionsFor(client).login('jane@example.com', '')).ok).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('turns a server error into a message instead of throwing', async () => {
        const { client } = fakeClient({ error: new Error('Invalid login credentials') });
        const r = await actionsFor(client).login('jane@example.com', 'wrong');
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Invalid login credentials');
    });
});

describe('forgotPassword', () => {
    it('sends the reset link to the configured destination', async () => {
        const { client, calls } = fakeClient();
        await actionsFor(client, () => 'https://cacoventures.com/admin').forgotPassword('jane@example.com');
        expect(calls).toEqual([['resetPasswordForEmail', 'jane@example.com', { redirectTo: 'https://cacoventures.com/admin' }]]);
    });

    it('does not reveal whether an account exists', async () => {
        const { client } = fakeClient();
        const r = await actionsFor(client).forgotPassword('jane@example.com');
        expect(r.ok).toBe(true);
        expect(r.message).toMatch(/^If jane@example\.com has an account/);
    });

    it('asks for an address first', async () => {
        const { client, calls } = fakeClient();
        expect((await actionsFor(client).forgotPassword('  ')).ok).toBe(false);
        expect(calls).toHaveLength(0);
    });
});

describe('setPassword', () => {
    it('refuses a mismatch, a blank field or a short password without calling the server', async () => {
        const { client, calls } = fakeClient();
        const a = actionsFor(client);
        expect((await a.setPassword('secret1', 'secret2')).message).toMatch(/do not match/);
        expect((await a.setPassword('', 'secret1')).ok).toBe(false);
        expect((await a.setPassword('abc', 'abc')).message).toMatch(/at least 6/);
        expect(calls).toHaveLength(0);
    });

    it('sends only the password to the server', async () => {
        const { client, calls } = fakeClient();
        const r = await actionsFor(client).setPassword('secret12', 'secret12');
        expect(r.ok).toBe(true);
        expect(calls).toEqual([['updateUser', { password: 'secret12' }]]);
    });
});

describe('googleLogin and logout', () => {
    it('passes the destination to Google sign-in', async () => {
        const { client, calls } = fakeClient();
        await actionsFor(client).googleLogin();
        expect(calls).toEqual([['signInWithOAuth', { provider: 'google', options: { redirectTo: 'https://cacoventures.com/' } }]]);
    });

    it('signs out', async () => {
        const { client, calls } = fakeClient();
        expect(await actionsFor(client).logout()).toEqual({ ok: true });
        expect(calls).toEqual([['signOut']]);
    });

    it('turns a server error from logout into a message instead of throwing', async () => {
        const { client } = fakeClient({ error: new Error('Session expired') });
        const r = await actionsFor(client).logout();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Sign-out failed');
        expect(r.message).toContain('Session expired');
    });

    it('turns a server error from googleLogin into a message instead of throwing', async () => {
        const { client } = fakeClient({ error: new Error('OAuth unavailable') });
        const r = await actionsFor(client).googleLogin();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Google sign-in failed');
        expect(r.message).toContain('OAuth unavailable');
    });
});

describe('forgotPassword server errors', () => {
    it('returns ok:false with the server reason instead of throwing', async () => {
        const { client } = fakeClient({ error: new Error('SMTP not configured') });
        const r = await actionsFor(client).forgotPassword('jane@example.com');
        expect(r.ok).toBe(false);
        expect(r.message).toContain('The reset email was not sent');
        expect(r.message).toContain('SMTP not configured');
    });
});

describe('setPassword server errors', () => {
    it('returns ok:false with the server reason instead of throwing', async () => {
        const { client } = fakeClient({ error: new Error('Auth token expired') });
        const r = await actionsFor(client).setPassword('secret12', 'secret12');
        expect(r.ok).toBe(false);
        expect(r.message).toContain('The password was not set');
        expect(r.message).toContain('Auth token expired');
    });
});
