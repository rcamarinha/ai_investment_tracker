import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runTask, AiError } from "../_shared/ai.ts";
import { buildTradeRequest, readTrades } from "../_shared/trade-prompts.js";

// Model, output cap and time limit: "trades.extract" in _shared/ai-tasks.js;
// the prompt and the input check in _shared/trade-prompts.js.
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
  // Who is calling, kept for recording usage — taken from the verified token,
  // never from the request body.
  let userId = "";
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
    userId = data.user.id;
  }

  try {
    const body = await req.json().catch(() => null);
    const built = buildTradeRequest(body);
    if ("error" in built) {
      return new Response(JSON.stringify({ error: built.error }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await runTask("trades.extract", {
      userId,
      prompt: built.prompt,
      // No balance can catch a half-read chunk here, so an answer without a
      // readable list is a failed call, not an empty one.
      usable: (text) => readTrades(text) !== null,
    });

    // The shape the page has always read: one text block holding a JSON array.
    return new Response(JSON.stringify({ content: [{ type: "text", text: result.text }], model: result.model }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : (err as Error)?.name;
    console.error("[extract-trades] failed:", kind);
    return new Response(
      JSON.stringify({
        error: kind === "timeout"
          ? "The extractor took too long on this part. Try a smaller file."
          : "Extraction service temporarily unavailable. Please try again later.",
      }),
      { status: kind === "timeout" ? 504 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
