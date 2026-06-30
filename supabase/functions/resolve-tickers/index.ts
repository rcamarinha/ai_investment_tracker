import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ORIGINS = [
  "https://cacoventures.com",
  "https://www.cacoventures.com",
  "https://ai-investment-tracker.vercel.app",
];
function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Manual auth (gateway JWT check is off; matches the other functions) ──
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing authorization token" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token. Please log in again." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "Anthropic API key not configured on server" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const items = Array.isArray(body?.items) ? body.items.slice(0, 60) : [];
    if (items.length === 0) {
      return new Response(JSON.stringify({ error: "items[] is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const list = items.map((it: { currentSymbol?: string; name?: string; isin?: string }, i: number) =>
      `${i + 1}. currentSymbol="${it.currentSymbol || ""}" name="${it.name || ""}" isin="${it.isin || ""}"`
    ).join("\n");

    const promptContent =
`For each instrument below, return the ticker symbol that a market-data API (Financial Modeling Prep / Yahoo Finance) would recognize for a live quote.

Rules:
- Prefer a US-listed ADR ticker when a liquid one exists (e.g. "Banco Santander" → "SAN"); otherwise return the primary European listing with the correct exchange suffix.
- Exchange suffixes: .DE Frankfurt/XETRA, .PA Paris, .AS Amsterdam, .MI Milan, .L London, .MC Madrid, .SW Swiss, .LS Lisbon, .BR Brussels, .CO Copenhagen, .ST Stockholm, .HE Helsinki, .OL Oslo, .VI Vienna.
- The "currentSymbol" is the one that FAILED to price — do not just echo it; give the format that works.
- If you cannot determine a real tradeable ticker, set "ticker" to null. Never invent one and never return an ISIN.
- Output ONLY a JSON array, no markdown, no prose: [{"input":"<currentSymbol>","ticker":"<symbol or null>"}].

Instruments:
${list}`;

    if (promptContent.length > 15_000) {
      return new Response(JSON.stringify({ error: "Too many instruments in one request" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
      console.error(`[resolve-tickers] Anthropic ${response.status}:`, errBody.slice(0, 300));
      return new Response(JSON.stringify({ error: "Resolver temporarily unavailable. Try again later." }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Return the raw Anthropic response; the client parses content[].text → JSON
    // (same contract as analyze-portfolio / extract-trades) and VALIDATES each
    // suggestion against a price API before trusting it.
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[resolve-tickers] error:", err.message || err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
