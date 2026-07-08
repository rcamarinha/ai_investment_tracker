import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Server-side quote proxy for symbols the free API tiers can't price —
// primarily EU-listed UCITS ETFs (Xetra/LSE/Euronext), which have no US twin
// and which Finnhub/FMP free plans won't quote. Uses Yahoo Finance's chart
// endpoint SERVER-SIDE (it is CORS-blocked from the browser — verified — and
// Stooq's old CSV endpoint is gone entirely). Keyless; symbols use the same
// Yahoo-style suffixes the app already normalizes to (.DE/.L/.PA/.AS/…), so
// no mapping is needed. Returns the listing currency too.
//
// POST { symbols: ["IUSQ.DE", "VWRL.L", ...] }
// → { results: { "IUSQ.DE": { price, currency, exchange, quotedSymbol } | null } }

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

const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

async function fetchYahooQuote(symbol: string): Promise<{ price: number; currency: string; exchange: string; quotedSymbol: string } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      price,
      currency: String(meta.currency || ""),
      exchange: String(meta.fullExchangeName || meta.exchangeName || ""),
      quotedSymbol: String(meta.symbol || symbol),
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Manual auth (verify_jwt is off — gateway JWT check is incompatible with
  // sb_publishable_ keys; same pattern as every other function in this app).
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
    const symbols: string[] = Array.isArray(body?.symbols) ? body.symbols.slice(0, 100) : [];
    if (symbols.length === 0) {
      return new Response(JSON.stringify({ error: "symbols[] is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const results: Record<string, unknown> = {};
    const CHUNK = 5;   // gentle concurrency against Yahoo
    for (let i = 0; i < symbols.length; i += CHUNK) {
      await Promise.all(symbols.slice(i, i + CHUNK).map(async (sym) => {
        results[String(sym).toUpperCase()] = await fetchYahooQuote(String(sym).trim());
      }));
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[quote-proxy] error:", (err as Error).message || err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
