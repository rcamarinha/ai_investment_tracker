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

    it('confirms the success message so invite-flow callers know what to show', () => {
        // An invited person's first action is setting a password. If this message
        // changes silently, the hub toast breaks their onboarding flow.
        const { client } = fakeClient();
        return actionsFor(client).setPassword('secret12', 'secret12').then(r => {
            expect(r.message).toBe('Password set. You are signed in.');
        });
    });

    it('turns a server rejection into a message, never throws', async () => {
        const { client } = fakeClient({ error: new Error('Password too weak') });
        const r = await actionsFor(client).setPassword('secret12', 'secret12');
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Password too weak');
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

    it('turns a Google sign-in failure into a message, never throws', async () => {
        const { client } = fakeClient({ error: new Error('OAuth popup blocked') });
        const r = await actionsFor(client).googleLogin();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('OAuth popup blocked');
    });

    it('turns a sign-out failure into a message, never throws', async () => {
        const { client } = fakeClient({ error: new Error('Network error') });
        const r = await actionsFor(client).logout();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Network error');
    });
});

describe('forgotPassword server errors', () => {
    it('turns a send failure into a message, never throws', async () => {
        const { client } = fakeClient({ error: new Error('Email rate limit exceeded') });
        const r = await actionsFor(client).forgotPassword('jane@example.com');
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Email rate limit exceeded');
    });
});
