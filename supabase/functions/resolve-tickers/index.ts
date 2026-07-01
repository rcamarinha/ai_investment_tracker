import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Resolve a priceable ticker (and, as a last resort, a live price) for holdings
// that every price API rejected. Uses live web search: Gemini 2.5 Flash + Google
// Search grounding, falling back to Claude with its web_search tool. Returns a
// uniform Anthropic-style shape { content:[{type:'text', text:'<json array>'}] }
// so the client parses both providers the same way, then VALIDATES each ticker
// against a price API before trusting it.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const CLAUDE_MODEL = "claude-sonnet-4-6";

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

function buildPrompt(items: Array<{ currentSymbol?: string; name?: string; isin?: string }>): string {
  const list = items.map((it, i) =>
    `${i + 1}. currentSymbol="${it.currentSymbol || ""}" name="${it.name || ""}" isin="${it.isin || ""}"`
  ).join("\n");
  return `You resolve stock/ETF tickers. For each instrument below, use web search to find:
- "ticker": the symbol a market-data API (Financial Modeling Prep / Yahoo Finance) recognizes for a live quote. Prefer a US-listed ADR when a liquid one exists; otherwise the primary European listing with the correct exchange suffix (.DE Frankfurt/XETRA, .PA Paris, .AS Amsterdam, .MI Milan, .L London, .MC Madrid, .SW Swiss, .LS Lisbon, .BR Brussels, .CO Copenhagen, .ST Stockholm, .HE Helsinki, .OL Oslo, .VI Vienna). The "currentSymbol" FAILED to price — give a format that works, don't echo it. Never return an ISIN. null if you cannot find a real ticker.
- "price": ONLY if you can find the current share price from a reputable live source, as a number in the instrument's listing currency; otherwise null.

Output ONLY a JSON array, no markdown, no prose:
[{"input":"<currentSymbol>","ticker":"<symbol or null>","price":<number or null>}]

Instruments:
${list}`;
}

async function callGemini(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE not set");
  const attempt = async (grounding: boolean) => {
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4000 },
    };
    if (grounding) body.tools = [{ google_search: {} }];
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p: { text?: string }) => p.text ?? "").join("");
  };
  try { return await attempt(true); }
  catch (e) { if (!String(e).includes("429")) throw e; return await attempt(false); }
}

async function callClaude(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  return (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing authorization token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token. Please log in again." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  try {
    const body = await req.json();
    const items = Array.isArray(body?.items) ? body.items.slice(0, 60) : [];
    if (items.length === 0) {
      return new Response(JSON.stringify({ error: "items[] is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const prompt = buildPrompt(items);
    if (prompt.length > 15_000) {
      return new Response(JSON.stringify({ error: "Too many instruments in one request" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Gemini + Google Search first; Claude + web_search as fallback.
    let text = "", source = "gemini";
    try {
      text = await callGemini(prompt);
    } catch (gErr) {
      console.warn("[resolve-tickers] Gemini failed, falling back to Claude:", (gErr as Error).message);
      try { text = await callClaude(prompt); source = "claude"; }
      catch (cErr) {
        console.error("[resolve-tickers] both providers failed:", (cErr as Error).message);
        return new Response(JSON.stringify({ error: "Resolver temporarily unavailable." }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Uniform Anthropic-style shape so the client parses either provider the same.
    return new Response(JSON.stringify({ content: [{ type: "text", text }], _source: source }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[resolve-tickers] error:", (err as Error).message || err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
