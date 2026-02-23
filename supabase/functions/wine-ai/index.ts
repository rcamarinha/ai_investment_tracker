/**
 * Supabase Edge Function — Wine AI
 *
 * Proxies requests to the Anthropic API using the server-side secret
 * ANTHROPIC_API_KEY_Wine, so users don't need to supply their own key.
 *
 * Supports three request types:
 *   "label"    — vision request: base64 image + text prompt → wine JSON
 *   "valuation"— text prompt → estimated bottle value JSON
 *   "analysis" — text prompt → cellar analysis JSON
 *
 * Request body:
 *   {
 *     requestType: "label" | "valuation" | "analysis",
 *     prompt: string,
 *     image?: { base64: string, mediaType: string },   // label only
 *     maxTokens?: number
 *   }
 *
 * The response body is the raw Anthropic API response (same shape as a
 * direct call), so callers can use the same parsing logic either way.
 */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY_Wine");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { requestType, prompt, image, maxTokens = 1024 } = body;

  if (!requestType || !prompt) {
    return jsonResponse({ error: "requestType and prompt are required" }, 400);
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
      { type: "text", text: prompt },
    ];
  } else {
    // Text-only request
    content = prompt;
  }

  // ── Call Anthropic ───────────────────────────────────────────────────────
  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
      }),
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
    return jsonResponse(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
