/**
 * Wine AI routing helper — centralises all AI calls for the wine tracker.
 *
 * All requests go through the Supabase Edge Function (wine-ai), which holds the
 * ANTHROPIC_API_KEY_Wine and GEMINI_WINE server-side secrets.
 * Users must be logged in to use AI features.
 */

import state from './state.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Route an AI request through the Supabase edge function.
 *
 * @param {object} opts
 * @param {'label'|'valuation'|'batch-valuation'|'analysis'} opts.requestType
 * @param {string}  [opts.prompt]         - Text prompt (required except batch-valuation)
 * @param {{base64: string, mediaType: string}} [opts.image] - Vision image (label only)
 * @param {number}  [opts.maxTokens]      - Defaults to 1024
 * @param {boolean} [opts.enableWebSearch] - Enable Anthropic web search tool (label/analysis)
 * @param {Array}   [opts.bottles]        - Array of bottle objects (batch-valuation only)
 * @returns {Promise<object>}             - { text } for single, { results } for batch
 */
export async function callWineAI({ requestType, prompt, image, maxTokens = 1024, enableWebSearch = false, bottles = null }) {
    if (!state.supabaseClient) {
        throw new Error('Supabase client not initialized. Please refresh the page.');
    }
    if (!state.currentUser) {
        throw new Error(
            'Please log in to use the AI features.\n\n' +
            'Sign in using the auth bar at the top of the page.'
        );
    }

    return _callEdgeFunction({ requestType, prompt, image, maxTokens, enableWebSearch, bottles });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Decode JWT payload claims without signature verification (diagnostics only). */
function _decodeJwtClaims(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
        return null;
    }
}

// ── Supabase Edge Function call ───────────────────────────────────────────────

async function _callEdgeFunction({ requestType, prompt, image, maxTokens, enableWebSearch, bottles }) {
    console.log('[WineAI] Using Supabase edge function: wine-ai');

    // Force a full token refresh so the access_token is freshly signed with the
    // project's current JWT_SECRET.
    // Get the current session. Only call refreshSession() if the access token is
    // expired or about to expire (within 60 s). Unconditionally refreshing on every
    // call rotates the single-use refresh token each time, which breaks long-running
    // batch operations (e.g. 800-bottle valuation = 80 sequential edge-fn calls).
    let session;
    {
        const { data: current } = await state.supabaseClient.auth.getSession();
        session = current?.session;

        const exp = _decodeJwtClaims(session?.access_token)?.exp ?? 0;
        const expiresInSeconds = exp - Math.floor(Date.now() / 1000);

        if (!session?.access_token || expiresInSeconds < 60) {
            console.log('[WineAI] Token expired or expiring soon — refreshing session');
            const { data, error } = await state.supabaseClient.auth.refreshSession();
            if (!error && data?.session?.access_token) {
                session = data.session;
            }
        }
    }
    if (!session?.access_token) {
        throw new Error(
            'Session expired. Please log in again to use the AI features.'
        );
    }

    // Decode JWT claims for diagnostics (no verification — just base64 decode).
    const _jwtClaims = _decodeJwtClaims(session.access_token);
    console.log('[WineAI] JWT claims:', _jwtClaims
        ? { iss: _jwtClaims.iss, role: _jwtClaims.role, exp: new Date(_jwtClaims.exp * 1000).toISOString() }
        : 'decode failed');

    // Normalise URL (remove trailing slash) and build function endpoint.
    const baseUrl = state.supabaseUrl.replace(/\/+$/, '');
    const functionUrl = `${baseUrl}/functions/v1/wine-ai`;
    console.log('[WineAI] Calling:', functionUrl);

    // Warn if the JWT issuer doesn't look like it belongs to this project.
    if (_jwtClaims?.iss && !functionUrl.startsWith(_jwtClaims.iss.replace(/\/auth\/v1$/, ''))) {
        console.warn(
            '[WineAI] JWT issuer mismatch!\n' +
            `  JWT iss : ${_jwtClaims.iss}\n` +
            `  Function: ${functionUrl}\n` +
            'The session belongs to a different Supabase project than the function URL. ' +
            'Check your Supabase URL in 🔑 API Keys.'
        );
    }

    const bearerToken = session.access_token;
    const anonIsJwt   = state.supabaseAnonKey.startsWith('eyJ');
    const payload     = JSON.stringify({ requestType, prompt, image, maxTokens, enableWebSearch, bottles });

    // Build a fetch attempt with specific auth headers.
    // Use an AbortController to enforce a client-side timeout slightly under the
    // Supabase edge-function limit (60s free / 150s paid).  Without this, a
    // timed-out function closes the connection without CORS headers, which the
    // browser reports as the opaque "Failed to fetch" instead of a useful message.
    const FETCH_TIMEOUT_MS = 55_000;
    const _doFetch = (authHeaders) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        return fetch(functionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: payload,
            signal: ac.signal,
        }).finally(() => clearTimeout(timer));
    };

    let response;
    try {
        // Attempt 1: user session JWT + apikey header (standard authenticated call).
        console.log('[WineAI] Attempt 1: session JWT + apikey');
        response = await _doFetch({
            'Authorization': `Bearer ${bearerToken}`,
            'apikey': state.supabaseAnonKey,
        });

        // Attempt 2: anon key as Bearer (legacy eyJ… anon keys are signed with the
        // project JWT_SECRET and accepted by the gateway regardless of user state).
        if (response.status === 401 && anonIsJwt && state.supabaseAnonKey !== bearerToken) {
            console.warn('[WineAI] Attempt 2: anon key JWT as Bearer');
            response = await _doFetch({
                'Authorization': `Bearer ${state.supabaseAnonKey}`,
                'apikey': state.supabaseAnonKey,
            });
        }

        // Attempt 3: no Authorization header at all — only apikey.
        if (response.status === 401) {
            console.warn('[WineAI] Attempt 3: apikey only (no Authorization header)');
            response = await _doFetch({ 'apikey': state.supabaseAnonKey });
        }

        // Attempt 4: no headers at all.
        if (response.status === 401) {
            console.warn('[WineAI] Attempt 4: no auth headers');
            response = await _doFetch({});
        }

        // Retry 529 (Anthropic overloaded) with backoff.
        for (const delay of [3000, 8000]) {
            if (response.status !== 529) break;
            console.warn(`[WineAI] Anthropic overloaded (529) via edge fn, retrying in ${delay / 1000}s…`);
            await _sleep(delay);
            response = await _doFetch({
                'Authorization': `Bearer ${bearerToken}`,
                'apikey': state.supabaseAnonKey,
            });
        }
    } catch (err) {
        console.error('[WineAI] Edge function fetch threw:', err);
        const isTimeout = err.name === 'AbortError';
        if (isTimeout) {
            throw new Error(
                `The Wine AI server took longer than ${FETCH_TIMEOUT_MS / 1000}s to respond.\n\n` +
                'This usually means the edge function timed out (Gemini + Claude fallback on the same batch exceeded the server limit).\n\n' +
                'The batch size has been kept small to minimise this — if it keeps happening, ' +
                'try valuating a smaller selection of bottles at a time.'
            );
        }
        throw new Error(
            'Network error contacting the Wine AI server (CORS or connectivity issue).\n\n' +
            'Verify your Supabase URL in 🔑 API Keys and that the wine-ai edge function ' +
            'is deployed. Open DevTools → Network tab for details.\n\n' +
            `Original error: ${err.message}`
        );
    }

    if (!response.ok) {
        let errData = null;
        let body = '';
        try {
            errData = await response.json();
            body = JSON.stringify(errData);
        } catch {
            body = await response.text().catch(() => '');
        }
        console.error(`[WineAI] Edge function HTTP error (${response.status}):`, body.slice(0, 300));

        if (response.status === 401) {
            throw new Error(
                'Wine AI authentication failed (401 — JWT verification is enabled on the deployed function).\n\n' +
                'supabase/functions/wine-ai/config.toml already has verify_jwt = false, but the ' +
                'live function was deployed before that setting was applied.\n\n' +
                'Fix: redeploy the function so the config takes effect:\n' +
                '  supabase functions deploy wine-ai\n\n' +
                'Or toggle it off manually in the Supabase Dashboard:\n' +
                '  Edge Functions → wine-ai → uncheck "Enforce JWT Verification"'
            );
        }
        if (response.status === 529) {
            throw new Error('Anthropic API is temporarily overloaded. Please wait a few seconds and try again.');
        }
        throw new Error(`Wine AI server error (${response.status}): ${errData?.error || body.slice(0, 200)}`);
    }

    const result = await response.json();
    _logGeminiDiagnostic(result, requestType);
    return result;
}

/**
 * Log Gemini grounding / diagnostic info embedded in any response body.
 */
function _logGeminiDiagnostic(data, requestType) {
    if (!data) return;
    if (data._geminiGrounding) {
        const src = Array.isArray(data._geminiGrounding)
            ? data._geminiGrounding.slice(0, 3).map(s => s.web?.uri || s.uri || '').filter(Boolean).join(', ')
            : '';
        console.log(`[WineAI] Gemini grounding sources: ${src || '(available)'}`);
    }
    if (data._geminiError) {
        console.warn(`[WineAI] Gemini error (${requestType}): ${data._geminiError}`);
    }
    if (requestType === 'batch-valuation' && Array.isArray(data.results)) {
        console.log(`[WineAI] Batch valuation returned ${data.results.length} result(s).`);
    }
}
