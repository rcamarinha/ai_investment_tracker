/**
 * Wine AI routing helper — centralises all Claude API calls for the wine tracker.
 *
 * Priority:
 *   1. Direct Anthropic API  — when state.anthropicKey is set (user's own key)
 *   2. Supabase Edge Function — falls back to the server-side ANTHROPIC_API_KEY_Wine
 *                               secret when Supabase is configured and user is logged in
 *
 * All callers (label.js, valuation.js, analysis.js) use callWineAI() and get
 * the same raw Anthropic response shape regardless of which path was used.
 */

import state from './state.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Route a Claude request through the best available channel.
 *
 * @param {object} opts
 * @param {'label'|'valuation'|'analysis'} opts.requestType
 * @param {string}  opts.prompt           - Text prompt (required for all types)
 * @param {{base64: string, mediaType: string}} [opts.image] - Vision image (label only)
 * @param {number}  [opts.maxTokens]      - Defaults to 1024
 * @param {boolean} [opts.enableWebSearch] - Enable Anthropic web search tool (valuation)
 * @returns {Promise<object>}             - Raw Anthropic API response
 */
export async function callWineAI({ requestType, prompt, image, maxTokens = 1024, enableWebSearch = false, bottleSearch = null }) {
    const hasDirectKey    = !!state.anthropicKey;
    const hasEdgeFunction = !!(state.supabaseUrl && state.supabaseAnonKey);

    if (!hasDirectKey && !hasEdgeFunction) {
        throw new Error(
            'No AI access configured.\n\n' +
            'Either add your Anthropic API key in 🔑 API Keys, ' +
            'or connect Supabase to use the shared server key.'
        );
    }

    if (hasDirectKey) {
        return _callDirect({ requestType, prompt, image, maxTokens, enableWebSearch });
    }
    // Edge function path requires an authenticated session to prevent quota abuse.
    if (!state.currentUser) {
        throw new Error(
            'Please log in to use the shared AI service.\n\n' +
            'Alternatively, add your own Anthropic API key in 🔑 API Keys.'
        );
    }
    return _callEdgeFunction({ requestType, prompt, image, maxTokens, enableWebSearch, bottleSearch });
}

// ── Direct Anthropic API call ─────────────────────────────────────────────────

async function _callDirect({ requestType, prompt, image, maxTokens, enableWebSearch }) {
    const content = (requestType === 'label' && image)
        ? [
            {
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
            },
            { type: 'text', text: prompt },
          ]
        : prompt;

    const headers = {
        'x-api-key': state.anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (enableWebSearch) {
        headers['anthropic-beta'] = 'web-search-2025-03-05';
    }

    const body = {
        model: 'claude-opus-4-6',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
    };
    if (enableWebSearch) {
        body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }

    console.log('[WineAI] Using direct Anthropic API path', enableWebSearch ? '(+web search)' : '');
    let response;
    try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    } catch (err) {
        console.error('[WineAI] Direct Anthropic fetch threw:', err);
        if (err instanceof TypeError) {
            throw new Error(
                'Network error contacting Anthropic API (CORS or connectivity issue).\n\n' +
                'Make sure you are serving the app over HTTP (not file://) and that ' +
                'your Anthropic API key is valid. Open DevTools → Network tab for details.\n\n' +
                `Original error: ${err.message}`
            );
        }
        throw err;
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[WineAI] Direct API HTTP ${response.status}:`, body.slice(0, 300));
        if (response.status === 401) {
            throw new Error('Invalid Anthropic API key. Check 🔑 API Keys settings.');
        }
        throw new Error(`Claude API error ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function _callEdgeFunction({ requestType, prompt, image, maxTokens, enableWebSearch, bottleSearch }) {
    if (!state.supabaseUrl || !state.supabaseAnonKey) {
        throw new Error(
            'Supabase not configured.\n\n' +
            'Make sure your Supabase URL and anon key are configured in 🔑 API Keys.'
        );
    }
    if (!state.supabaseClient) {
        throw new Error(
            'Supabase client not initialized.\n\n' +
            'Make sure your Supabase URL and anon key are configured in 🔑 API Keys.'
        );
    }

    console.log('[WineAI] Using Supabase edge function: wine-ai');

    // Force a full token refresh so the access_token is freshly signed with the
    // project's current JWT_SECRET. getSession() returns whatever is cached in
    // memory and only refreshes lazily; if the token is near expiry or the
    // project's JWT_SECRET was rotated, the cached token fails gateway validation
    // even though it looks non-expired on the client.
    let session;
    {
        const { data, error } = await state.supabaseClient.auth.refreshSession();
        if (!error && data?.session?.access_token) {
            session = data.session;
        } else {
            // refreshSession() failed (offline, revoked refresh token, etc.)
            // Fall back to whatever the SDK has cached.
            const { data: fallback } = await state.supabaseClient.auth.getSession();
            session = fallback?.session;
        }
    }
    if (!session?.access_token) {
        throw new Error(
            'Session expired. Please log in again to use the shared AI service.\n\n' +
            'Alternatively, add your own Anthropic API key in 🔑 API Keys.'
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
    const payload     = JSON.stringify({ requestType, prompt, image, maxTokens, enableWebSearch, bottleSearch });

    // Build a fetch attempt with specific auth headers.
    const _doFetch = (authHeaders) => fetch(functionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: payload,
    });

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
        // When verify_jwt is disabled on the function this should always work.
        if (response.status === 401) {
            console.warn('[WineAI] Attempt 3: apikey only (no Authorization header)');
            response = await _doFetch({ 'apikey': state.supabaseAnonKey });
        }

        // Attempt 4: no headers at all (handles cases where apikey itself is invalid).
        if (response.status === 401) {
            console.warn('[WineAI] Attempt 4: no auth headers');
            response = await _doFetch({});
        }
    } catch (err) {
        console.error('[WineAI] Edge function fetch threw:', err);
        throw new Error(
            'Network error contacting the Wine AI server (CORS or connectivity issue).\n\n' +
            'Verify your Supabase URL in 🔑 API Keys and that the wine-ai edge function ' +
            'is deployed. Open DevTools → Network tab for details.\n\n' +
            `Original error: ${err.message}`
        );
    }

    if (!response.ok) {
        // Parse as JSON so we can surface the OpenAI diagnostic even on error.
        let errData = null;
        let body = '';
        try {
            errData = await response.json();
            body = JSON.stringify(errData);
        } catch {
            body = await response.text().catch(() => '');
        }
        console.error(`[WineAI] Edge function HTTP error (${response.status}):`, body.slice(0, 300));

        // Log OpenAI search result even though Anthropic failed.
        _logOpenAIDiagnostic(errData, requestType);

        if (response.status === 401) {
            throw new Error(
                'Wine AI authentication failed (401 Invalid JWT).\n\n' +
                'The wine-ai edge function has JWT verification enabled. Disable it via:\n' +
                '• Dashboard: Supabase project → Edge Functions → wine-ai → toggle off "Verify JWT"\n' +
                '• CLI: supabase functions deploy wine-ai --no-verify-jwt\n\n' +
                'Check the browser console for a JWT issuer mismatch warning if the ' +
                'issue persists after disabling verification.'
            );
        }
        throw new Error(`Wine AI server error (${response.status}): ${errData?.error || body.slice(0, 200)}`);
    }

    const result = await response.json();
    _logOpenAIDiagnostic(result, requestType);
    return result;
}

/**
 * Log the OpenAI market-search diagnostic embedded in any response body.
 * _openaiChars/_openaiError are in the body (not headers) because Supabase's
 * gateway strips custom response headers before they reach the browser.
 * Called from both the success path and the Anthropic-error path.
 */
function _logOpenAIDiagnostic(data, requestType) {
    if (!data || typeof data._openaiChars !== 'number') return;
    if (data._openaiChars > 0) {
        console.log(`[WineAI] OpenAI market search: ${data._openaiChars} chars injected into prompt ✓`);
    } else if (!data._openaiCalled) {
        // OpenAI is only called for valuation requests — don't warn for label/analysis.
        if (requestType === 'valuation') {
            console.warn('[WineAI] OpenAI market search skipped — bottleSearch was empty (bottle has no name/vintage/winery/region?)');
        }
    } else if (data._openaiError) {
        console.warn(`[WineAI] OpenAI market search failed: ${data._openaiError}`);
    } else {
        console.warn('[WineAI] OpenAI market search: API returned empty content (gpt-4o-search-preview returned no text)');
    }
}
