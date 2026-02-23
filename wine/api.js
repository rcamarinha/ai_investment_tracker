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
 * @param {string}  opts.prompt      - Text prompt (required for all types)
 * @param {{base64: string, mediaType: string}} [opts.image] - Vision image (label only)
 * @param {number}  [opts.maxTokens] - Defaults to 1024
 * @returns {Promise<object>}        - Raw Anthropic API response
 */
export async function callWineAI({ requestType, prompt, image, maxTokens = 1024 }) {
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
        return _callDirect({ requestType, prompt, image, maxTokens });
    }
    return _callEdgeFunction({ requestType, prompt, image, maxTokens });
}

// ── Direct Anthropic API call ─────────────────────────────────────────────────

async function _callDirect({ requestType, prompt, image, maxTokens }) {
    const content = (requestType === 'label' && image)
        ? [
            {
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
            },
            { type: 'text', text: prompt },
          ]
        : prompt;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': state.anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
            model: 'claude-opus-4-6',
            max_tokens: maxTokens,
            messages: [{ role: 'user', content }],
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 401) {
            throw new Error('Invalid Anthropic API key. Check 🔑 API Keys settings.');
        }
        throw new Error(`Claude API error ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json();
}

// ── Supabase Edge Function call ───────────────────────────────────────────────

async function _callEdgeFunction({ requestType, prompt, image, maxTokens }) {
    // Prefer a logged-in session token; fall back to the anon key
    let authToken = state.supabaseAnonKey;
    if (state.supabaseClient) {
        try {
            const { data: { session } } = await state.supabaseClient.auth.getSession();
            if (session?.access_token) authToken = session.access_token;
        } catch { /* ignore — keep anon token */ }
    }

    const response = await fetch(`${state.supabaseUrl}/functions/v1/wine-ai`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': state.supabaseAnonKey,
            'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ requestType, prompt, image, maxTokens }),
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Wine AI server error (${response.status}): ${text.slice(0, 200)}`);
    }

    return JSON.parse(text);
}
