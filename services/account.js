/**
 * Account actions over an injected Supabase client: sign in, sign out, sign in
 * with Google, request a password reset, set a password.
 *
 * No imports and no DOM. The caller reads its own inputs and decides how to show
 * the result, which is why this can be tested with a fake client and shared by
 * every page. Five pages each carry their own copy of these handlers today, and
 * those copies have drifted: one guards a missing client and four do not, some
 * alert() and some toast. The admin page uses this module rather than becoming a
 * sixth copy. Moving the other five onto it is tracked in the plan.
 *
 * Every action resolves to { ok, message? } and never throws.
 */

const MIN_PASSWORD = 6;

export function createAccountActions({ getClient, redirectTo } = {}) {
    const client = () => (typeof getClient === 'function' ? getClient() : null) || null;
    const destination = () => (typeof redirectTo === 'function' ? redirectTo() : redirectTo) || undefined;
    const notReady = () => ({ ok: false, message: 'Sign-in is not ready yet. Refresh the page.' });
    const failed = (what, err) => ({ ok: false, message: `${what}: ${err?.message || String(err)}` });

    return {
        async login(email, password) {
            const c = client();
            if (!c) return notReady();
            const e = String(email ?? '').trim();
            if (!e || !password) return { ok: false, message: 'Enter your email and password.' };
            try {
                const { error } = await c.auth.signInWithPassword({ email: e, password });
                if (error) throw error;
                return { ok: true };
            } catch (err) { return failed('Sign-in failed', err); }
        },

        async logout() {
            const c = client();
            if (!c) return notReady();
            try {
                const { error } = await c.auth.signOut();
                if (error) throw error;
                return { ok: true };
            } catch (err) { return failed('Sign-out failed', err); }
        },

        async googleLogin() {
            const c = client();
            if (!c) return notReady();
            try {
                const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: destination() } });
                if (error) throw error;
                return { ok: true };
            } catch (err) { return failed('Google sign-in failed', err); }
        },

        async forgotPassword(email) {
            const c = client();
            if (!c) return notReady();
            const e = String(email ?? '').trim();
            if (!e) return { ok: false, message: 'Enter your email address first.' };
            try {
                const { error } = await c.auth.resetPasswordForEmail(e, { redirectTo: destination() });
                if (error) throw error;
                // Worded so it says nothing about whether that address has an account.
                return { ok: true, message: `If ${e} has an account, a link to set a new password is on its way.` };
            } catch (err) { return failed('The reset email was not sent', err); }
        },

        async setPassword(password, confirm) {
            const c = client();
            if (!c) return notReady();
            if (!password || !confirm) return { ok: false, message: 'Fill in both password fields.' };
            if (password !== confirm) return { ok: false, message: 'The passwords do not match.' };
            if (String(password).length < MIN_PASSWORD) {
                return { ok: false, message: `Use at least ${MIN_PASSWORD} characters.` };
            }
            try {
                const { error } = await c.auth.updateUser({ password });
                if (error) throw error;
                return { ok: true, message: 'Password set. You are signed in.' };
            } catch (err) { return failed('The password was not set', err); }
        },
    };
}
