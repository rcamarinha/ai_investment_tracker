/**
 * categorize-transactions — assign a spending category to each transaction.
 *
 * Secrets: GEMINI_WINE (primary), ANTHROPIC_API_KEY (fallback). Same pair the
 * other functions use; nothing new to configure.
 *
 * MODEL CHOICE: classification against a fixed, user-supplied list. Cheap
 * models are correct here — a frontier model would multiply the cost of a
 * routine monthly import for no accuracy that matters, since anything the model
 * is unsure about goes to human review anyway.
 *
 * WHAT IT RECEIVES: id, description, amount and direction. Never a balance,
 * never an account, never the raw bank text. The caller has already removed
 * everything it can settle without a model — rows matched by a learned rule,
 * transfers paired between the user's own accounts, and credits matching a
 * known income category.
 *
 * WHAT PROTECTS THE LEDGER: the caller matches answers back by id (never by
 * position), refuses categories outside the user's own list, files only results
 * at or above a confidence threshold, and forces anything unusually large into
 * review regardless of confidence.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runTask, AiError } from "../_shared/ai.ts";
import { buildCategoriseRequest, readRows } from "../_shared/spend-prompts.js";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

// Models, caps and time limits: "transactions.categorize" in _shared/ai-tasks.js. The prompt
// and the checks on what the page sends: _shared/spend-prompts.js.

const MAX_BATCH = 60;   // the client batches at 40; this is the hard stop

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
  const built = buildCategoriseRequest(body);
  if ("error" in built) return jsonResponse({ error: built.error }, built.status ?? 400, corsHeaders);

  let result;
  try {
    result = await runTask("transactions.categorize", { userId, prompt: built.prompt, usable: (t) => readRows(t) !== null });
  } catch (err) {
    console.error("[categorize-transactions] failed:", err instanceof AiError ? `${err.kind}${err.primary ? ` after ${err.primary.kind}` : ""}` : (err as Error)?.name);
    // Generic to the caller; the kind of failure stays in the logs.
    return jsonResponse({ error: "Categorisation service is unavailable right now." }, 502, corsHeaders);
  }

  const results = readRows(result.text) ?? [];
  return jsonResponse(
    { results, provider: result.provider === "gemini" ? "gemini" : "claude", model: result.model, asked: built.asked },
    200, corsHeaders,
  );
});
