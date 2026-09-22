/**
 * extract-statement — turn bank-statement text into ledger rows.
 *
 * Secrets (set with `supabase secrets set`):
 *   GEMINI_WINE           — primary. Already set for the wine module; reused
 *                           deliberately rather than adding a second key.
 *   ANTHROPIC_API_KEY     — fallback only, used when Gemini errors or is unset.
 *
 * MODEL CHOICE: this is structured extraction, not reasoning — read lines,
 * emit JSON. The cheapest capable model is the correct one, so Gemini Flash
 * leads and Claude Haiku backs it up. Nothing here needs a frontier model, and
 * using one would multiply the cost of a routine monthly import for no gain.
 *
 * WHAT THE CLIENT SENDS: layout-reconstructed LINES, not a flat text dump.
 * The app's older PDF reader joined every fragment on a page with spaces,
 * destroying the table before the model ever saw it. Sending real lines is
 * what makes a small model sufficient here.
 *
 * WHAT PROTECTS THE LEDGER: the client re-checks every returned row against the
 * statement's own running balance (balance[n] - balance[n-1] === amount[n]).
 * Rows that do not reconcile go to review rather than into the ledger, so a
 * model mistake is caught arithmetically instead of trusted.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runTask, AiError } from "../_shared/ai.ts";
import { buildStatementRequest, readRows } from "../_shared/spend-prompts.js";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

// Models, caps and time limits: "statements.extract" in _shared/ai-tasks.js. The prompt
// and the checks on what the page sends: _shared/spend-prompts.js.

const ALLOWED_ORIGINS = [
  "https://cacoventures.com",
  "https://www.cacoventures.com",
  "https://ai-investment-tracker.vercel.app",
];

/**
 * Local development, opt-in.
 *
 * Every edge function in this project allows only the three production origins,
 * so none of them can be exercised from `localhost` — the preflight is refused
 * and the browser reports a bare "Failed to fetch" with no clue why. Set
 * ALLOW_LOCAL_ORIGINS=true on a dev project to permit it. It stays OFF by
 * default so production CORS is never widened by accident, and auth is still
 * required either way.
 */
const ALLOW_LOCAL = (Deno.env.get("ALLOW_LOCAL_ORIGINS") || "").toLowerCase() === "true";
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOW_LOCAL && LOCAL_ORIGIN.test(origin);
}

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Why a provider failed, in words the user can act on and nothing more: no
 * key, no prompt, no statement text. A missing key and a spent quota are the
 * usual reasons BOTH fail at once, so they are named.
 */
function why(err: AiError | undefined): string {
  if (!err) return "failed";
  if (err.kind === "config") return "not configured";
  if (err.kind === "timeout") return "timed out";
  if (err.kind === "http") return `HTTP ${err.status}`;
  return err.kind;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);

  // verify_jwt is off (incompatible with sb_publishable_ keys), so auth is
  // checked here explicitly.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ error: "Missing authorization token" }, 401, corsHeaders);

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: authError } = await sb.auth.getUser(token);
  if (authError || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired token. Please sign in again." }, 401, corsHeaders);
  }
  // The verified caller, for recording usage — never taken from the request body.
  const userId = userData.user.id;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  const built = buildStatementRequest(body);
  if ("error" in built) return jsonResponse({ error: built.error }, built.status ?? 400, corsHeaders);

  let result;
  try {
    // An answer with no readable array is a failed call: the fallback runs.
    result = await runTask("statements.extract", { userId, prompt: built.prompt, usable: (t) => readRows(t) !== null });
  } catch (err) {
    const last = err instanceof AiError ? err : undefined;
    const gemini = last?.primary ?? last, claude = last?.primary ? last : undefined;
    console.error(`[extract-statement] both providers failed — gemini: ${why(gemini)}; claude: ${why(claude)}`);
    // 502, not 200-with-nothing: the page must tell a section that held no
    // transactions from one that was lost.
    return jsonResponse({
      error: `Both extraction providers failed — Gemini: ${why(gemini)}; Claude: ${why(claude)}. ` +
             `"not configured" means the server is missing that provider\u2019s key; HTTP 429 means its quota is used up.`,
    }, 502, corsHeaders);
  }

  const rows = readRows(result.text) ?? [];
  return jsonResponse(
    { rows, provider: result.provider === "gemini" ? "gemini" : "claude", model: result.model, promptChars: built.chars },
    200, corsHeaders,
  );
});
