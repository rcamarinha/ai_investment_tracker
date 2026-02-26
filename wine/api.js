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
export async function callWineAI({ requestType, prompt, image, maxTokens = 1024, enableWebSearch = false }) {
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
    return _callEdgeFunction({ requestType, prompt, image, maxTokens, enableWebSearch });
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

// ── Supabase Edge Function call ───────────────────────────────────────────────

async function _callEdgeFunction({ requestType, prompt, image, maxTokens, enableWebSearch }) {
    // Prefer a logged-in session JWT; the anon key is only a valid Bearer token
    // when it is itself a JWT (legacy eyJ... format). Newer Supabase publishable
    // keys (sb_publishable_*) must NOT be sent as Authorization: Bearer — they
    // only belong in the apikey header. Without a real JWT, omit Authorization
    // entirely (the edge function has verify_jwt = false so this is fine).
    let authToken = null;
    if (state.supabaseClient) {
        try {
            const { data: { session } } = await state.supabaseClient.auth.getSession();
            if (session?.access_token) authToken = session.access_token;
        } catch { /* ignore */ }
    }
    // Fall back to anon key only if it's a proper JWT (starts with eyJ)
    if (!authToken && state.supabaseAnonKey?.startsWith('eyJ')) {
        authToken = state.supabaseAnonKey;
    }

    const edgeUrl = `${state.supabaseUrl}/functions/v1/wine-ai`;
    console.log('[WineAI] Using Supabase edge function:', edgeUrl);
    const headers = {
        'Content-Type': 'application/json',
        'apikey': state.supabaseAnonKey,
    };
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    let response;
    try {
        response = await fetch(edgeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ requestType, prompt, image, maxTokens, enableWebSearch }),
        });
    } catch (err) {
        console.error('[WineAI] Edge function fetch threw:', err);
        if (err instanceof TypeError) {
            throw new Error(
                'Network error contacting the Wine AI server (CORS or connectivity issue).\n\n' +
                'Verify your Supabase URL in 🔑 API Keys and that the wine-ai edge function ' +
                'is deployed and responding to OPTIONS preflight requests. ' +
                'Open DevTools → Network tab and look for a failed OPTIONS request.\n\n' +
                `Original error: ${err.message}`
            );
        }
        throw err;
    }

    const text = await response.text();
    if (!response.ok) {
        console.error(`[WineAI] Edge function HTTP ${response.status}:`, text.slice(0, 300));
        throw new Error(`Wine AI server error (${response.status}): ${text.slice(0, 200)}`);
    }

    return JSON.parse(text);
}
