import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordUsage } from "../_shared/usage.ts";
import { validateRequest, buildUpstream, redact, callSucceeded } from "../_shared/market-data-core.js";

// Calls Finnhub, FMP and Alpha Vantage on the browser's behalf, with keys the
// browser never sees (plan P3 part 2).
//
// The three shared keys used to sit in app_config, readable by every signed-in
// account and copied into each browser's localStorage. With invite-only
// accounts, every invitee could read them. They now live only here, as secrets:
//
//   supabase secrets set FINNHUB_API_KEY=… FMP_API_KEY=… ALPHAVANTAGE_API_KEY=…
//
// POST { op: "status" }                          → { finnhub, fmp, alphavantage } (true when set)
// POST { provider, op, symbol | symbols | isin | query }
//   → 200 { status, body }   the provider's own HTTP status and response text
//
// A deliberate pass-through: the browser keeps every rule about reading a
// provider's answer (services/pricing-core.js, pinned by tests). The endpoint
// list, input checks and redaction live in ../_shared/market-data-core.js.
//
// One upstream call per request, 8-second timeout, no retries: the browser's
// fallback ladder already is the retry, and a hidden retry here would spend
// the shared quota where nobody can see it.
//
// NEVER log or return a URL or a fetch error message. FMP and Alpha Vantage
// accept the key only in the query string, and network errors quote the URL.

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

// Read on every request, not once at start-up: an instance already running
// would otherwise keep serving an old key after `supabase secrets set`, which
// is exactly the moment — rotation — when the old key must stop being used.
function readKeys(): Record<string, string> {
  return {
    finnhub:      (Deno.env.get("FINNHUB_API_KEY") || "").trim(),
    fmp:          (Deno.env.get("FMP_API_KEY") || "").trim(),
    alphavantage: (Deno.env.get("ALPHAVANTAGE_API_KEY") || "").trim(),
  };
}

const MAX_BODY = 2_000_000;   // bytes; the largest real reply is an FMP batch of 50

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
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    // ── Who is calling ──────────────────────────────────────────────────────
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json(401, { error: "Missing authorization token" });
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return json(401, { error: "Invalid or expired token. Please log in again." });
    const userId = data.user.id;

    let body: unknown;
    try { body = await req.json(); } catch { return json(400, { error: "Invalid request." }); }

    const KEYS = readKeys();
    const request = validateRequest(body);
    if (!request.ok) return json(400, { error: request.error });
    if ("status" in request) {
      return json(200, { finnhub: !!KEYS.finnhub, fmp: !!KEYS.fmp, alphavantage: !!KEYS.alphavantage });
    }

    const key = KEYS[request.provider];
    if (!key) return json(503, { error: `${request.provider} is not configured on the server.` });

    const { url, headers } = buildUpstream(request, key);
    let status = 0;
    let text = "";
    try {
      // redirect: "error" — a followed redirect would carry the key (in the URL,
      // or Finnhub's custom header, which fetch does not strip) to another host.
      const upstream = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(8000) });
      status = upstream.status;
      text = await upstream.text();
    } catch (_err) {
      // The error message may quote the URL, which holds the key. Say nothing specific.
      recordUsage({ userId, fn: "market-data", provider: request.provider, ok: false, units: request.units });
      console.warn("[market-data] upstream unreachable:", request.provider, request.op);
      return json(502, { error: "The price provider could not be reached." });
    }

    if (text.length > MAX_BODY) {
      recordUsage({ userId, fn: "market-data", provider: request.provider, ok: false, units: request.units });
      console.warn("[market-data] reply too large:", request.provider, request.op, text.length);
      return json(502, { error: "The price provider sent an unexpectedly large reply." });
    }

    recordUsage({
      userId, fn: "market-data", provider: request.provider,
      ok: callSucceeded(request.provider, status, text), units: request.units,
    });
    return json(200, { status, body: redact(text, Object.values(KEYS)) });
  } catch (err) {
    console.error("[market-data] error:", (err as Error)?.name || "unknown");
    return json(500, { error: "Internal server error" });
  }
});
