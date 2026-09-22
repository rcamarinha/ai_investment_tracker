import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runTask, AiError } from "../_shared/ai.ts";
import { buildTickerRequest, readTickerAnswer } from "../_shared/ticker-prompts.js";

// Resolve a priceable ticker (and, as a last resort, a live price) for holdings
// that every price API rejected. Gemini with Google Search, falling back to
// Claude with capped web search (runTask, _shared/ai.ts). Returns the shape the
// page has always read, { content:[{type:'text', text:'<json array>'}] }; the
// page VALIDATES each ticker against a price API before trusting it.

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

// Models, time limits and the search cap are in _shared/ai-tasks.js
// ("tickers.resolve"); the prompt and answer checks in _shared/ticker-prompts.js.

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
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing authorization token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  // The verified caller, for recording usage — never taken from the request body.
  let userId = "";
  {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token. Please log in again." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    userId = data.user.id;
  }
  try {
    const body = await req.json().catch(() => null);
    const built = buildTickerRequest(body);
    if ("error" in built) {
      return new Response(JSON.stringify({ error: built.error }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result = await runTask("tickers.resolve", {
      userId,
      prompt: built.prompt,
      // An answer with no readable array goes to the fallback, not to the page.
      usable: (text) => readTickerAnswer(text, built.symbols, false) !== null,
    });
    const rows = readTickerAnswer(result.text, built.symbols, result.searches > 0);
    if (!rows) {
      console.warn(`[resolve-tickers] ${result.provider} answer had no readable JSON array`);
      return new Response(JSON.stringify({ error: "Resolver returned an unreadable answer." }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // The page reads the same shape as before: one text block holding a JSON array.
    return new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(rows) }],
      _source: result.provider === "gemini" ? "gemini" : "claude",
      _searched: result.searches > 0,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : (err as Error)?.name;
    console.error("[resolve-tickers] failed:", kind);
    return new Response(JSON.stringify({ error: "Resolver temporarily unavailable." }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
