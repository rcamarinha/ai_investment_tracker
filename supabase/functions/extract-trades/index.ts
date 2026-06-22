import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

// ── CORS: restrict to known origins ──────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://cacoventures.com",
  "https://www.cacoventures.com",
  "https://ai-investment-tracker.vercel.app",
];
function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Manual auth verification ─────────────────────────────────────────────
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing authorization token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      console.warn("[extract-trades] Auth failed:", error?.message || "no user");
      return new Response(JSON.stringify({ error: "Invalid or expired token. Please log in again." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[extract-trades] Authenticated user:", data.user.id);
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Anthropic API key not configured on server" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const statementText = String(body?.text || "");

    if (!statementText.trim()) {
      return new Response(
        JSON.stringify({ error: "Statement text is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cap input length (the client chunks long statements before sending).
    if (statementText.length > 15_000) {
      return new Response(
        JSON.stringify({ error: "Text too long (max 15000 chars). Split it into smaller parts." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const promptContent =
`You are a precise financial statement parser. Extract every EXECUTED buy or sell securities trade from the statement text below.

Rules:
- Output ONLY a JSON array. No markdown, no commentary, no preamble.
- Each element: {"date":"YYYY-MM-DD","identifier":"<ticker or ISIN>","side":"buy"|"sell","shares":<number>,"price":<number per share>,"fees":<number>,"currency":"<ISO code>"}.
- "identifier" is the ticker symbol if present, otherwise the ISIN.
- "price" is the price PER SHARE in the trade's native currency (compute from total/quantity if only a total is shown).
- "shares" is always a positive number; use "side" to indicate direction.
- IGNORE dividends, interest, deposits, withdrawals, top-ups, currency exchanges, fee-only rows, and stock splits.
- If no trades are present, output [].

Statement text:
"""
${statementText}
"""`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: promptContent }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[extract-trades] Anthropic API error ${response.status}:`, errBody.slice(0, 300));
      return new Response(
        JSON.stringify({ error: "Extraction service temporarily unavailable. Please try again later." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    // Return the raw Anthropic response; the client parses content[].text → JSON array
    // (same contract as analyze-portfolio).
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[extract-trades] Unexpected error:", err.message || err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
