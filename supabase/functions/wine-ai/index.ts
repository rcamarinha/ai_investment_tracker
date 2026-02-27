/**
 * Supabase Edge Function — Wine AI
 *
 * Proxies requests to the Anthropic API using the server-side secret
 * ANTHROPIC_API_KEY_Wine, so users don't need to supply their own key.
 *
 * For valuation requests, the function also calls OpenAI gpt-4o-search-preview
 * (using OPENAI_API_KEY_Wine) to fetch live market prices before handing the
 * enriched prompt to Claude. If the OpenAI key is absent or the search fails,
 * it falls back to Claude alone.
 *
 * Request body:
 *   {
 *     requestType: "label" | "valuation" | "analysis",
 *     prompt: string,
 *     image?: { base64: string, mediaType: string },   // label only
 *     maxTokens?: number,
 *     enableWebSearch?: boolean,
 *     bottleSearch?: string   // valuation only: compact bottle identity for OpenAI search
 *   }
 *
 * The response body is the raw Anthropic API response (same shape as a
 * direct call), so callers can use the same parsing logic either way.
 */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY_Wine");
const OPENAI_API_KEY    = Deno.env.get("OPENAI_API_KEY_Wine");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-wine-ai-openai-chars",
};

function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

// ── OpenAI market-price search ───────────────────────────────────────────────

/**
 * Use gpt-4o-search-preview to fetch live retail / auction prices for a wine.
 * Returns { content, error } — error is a human-readable string on failure, "" on success.
 */
async function fetchOpenAIMarketPrices(
  bottleSearch: string
): Promise<{ content: string; error: string }> {
  if (!OPENAI_API_KEY) return { content: "", error: "OPENAI_API_KEY_Wine secret not set" };

  const query =
    `Find current retail and auction market prices (in EUR and USD) for this specific wine bottle: ${bottleSearch}. ` +
    `Search Wine-Searcher, Vivino, Chateau Online, and recent auction results (Sotheby's, Christie's, Acker Merrall, Zachys). ` +
    `Report the price range per 750ml bottle, average market price, currency, and any available drink-window guidance. ` +
    `Be concise and cite specific prices found.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-search-preview",
        web_search_options: { search_context_size: "high" },
        messages: [{ role: "user", content: query }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const errMsg = `HTTP ${res.status}: ${errText.slice(0, 200)}`;
      console.warn(`[wine-ai] OpenAI search ${errMsg}`);
      return { content: "", error: errMsg };
    }

    const data = await res.json();
    const content: string = data.choices?.[0]?.message?.content ?? "";
    console.log(`[wine-ai] OpenAI market data (${content.length} chars) for: ${bottleSearch.slice(0, 60)}`);
    return { content, error: "" };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn("[wine-ai] OpenAI search threw:", errMsg);
    return { content: "", error: errMsg };
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // ── CORS preflight ──────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── Key check ───────────────────────────────────────────────────────────
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse(
      { error: "ANTHROPIC_API_KEY_Wine is not set on the server." },
      500
    );
  }

  // ── Parse request body ──────────────────────────────────────────────────
  let body: {
    requestType: string;
    prompt: string;
    image?: { base64: string; mediaType: string };
    maxTokens?: number;
    enableWebSearch?: boolean;
    bottleSearch?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const {
    requestType,
    prompt,
    image,
    maxTokens = 1024,
    enableWebSearch = false,
    bottleSearch,
  } = body;

  if (!requestType || !prompt) {
    return jsonResponse({ error: "requestType and prompt are required" }, 400);
  }

  // ── OpenAI market research (valuation requests only) ────────────────────
  // When OPENAI_API_KEY_Wine is set and a bottleSearch string is provided,
  // fetch live prices and inject them into the prompt before calling Claude.
  let finalPrompt = prompt;
  let openaiChars = 0;
  let openaiError = "";

  if (requestType === "valuation" && bottleSearch) {
    const { content: marketData, error } = await fetchOpenAIMarketPrices(bottleSearch);
    openaiChars = marketData.length;
    openaiError = error;
    if (marketData) {
      finalPrompt =
        prompt +
        `\n\n=== LIVE MARKET DATA (fetched just now via web search) ===\n` +
        marketData +
        `\n\nBase your JSON values on the prices found above — prefer this data over your training knowledge.`;
    }
  }

  // ── Build Anthropic messages ─────────────────────────────────────────────
  type MessageContent =
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      >;

  let content: MessageContent;

  if (requestType === "label" && image?.base64) {
    // Vision request: image + text
    content = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType || "image/jpeg",
          data: image.base64,
        },
      },
      { type: "text", text: finalPrompt },
    ];
  } else {
    // Text-only request
    content = finalPrompt;
  }

  // ── Call Anthropic ───────────────────────────────────────────────────────
  try {
    const anthropicHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    };
    if (enableWebSearch) {
      anthropicHeaders["anthropic-beta"] = "web-search-2025-03-05";
    }

    const anthropicBody: Record<string, unknown> = {
      model: "claude-opus-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };
    if (enableWebSearch) {
      anthropicBody.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(anthropicBody),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => "");
      return jsonResponse(
        {
          error: `Anthropic API error: ${anthropicRes.status}`,
          details: errBody.slice(0, 300),
        },
        anthropicRes.status
      );
    }

    const data = await anthropicRes.json();
    // Embed openaiChars/_openaiError in the body — Supabase's gateway strips
    // custom response headers before they reach the browser, so the header
    // alone isn't readable via response.headers.get() in JavaScript.
    return jsonResponse(
      { ...data, _openaiChars: openaiChars, _openaiError: openaiError },
      200,
      { "x-wine-ai-openai-chars": String(openaiChars) }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
