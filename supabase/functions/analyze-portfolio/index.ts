import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runTask, AiError } from "../_shared/ai.ts";
import { buildAnalysisRequest } from "../_shared/analysis-prompts.js";

// The model, output cap and time limit for each analysis live in
// _shared/ai-tasks.js ("analysis.markets", "analysis.tradeIdeas",
// "analysis.movers"); the prompts in _shared/analysis-prompts.js.
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
      console.warn("[analyze-portfolio] Auth failed:", error?.message || "no user");
      return new Response(JSON.stringify({ error: "Invalid or expired token. Please log in again." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[analyze-portfolio] Authenticated user:", data.user.id);
    userId = data.user.id;
  }

  try {
    const body = await req.json().catch(() => null);
    // The browser sends data only; the prompt is built here. A body that still
    // carries a "prompt" (an old page) is refused with the rest.
    const built = buildAnalysisRequest(body);
    if ("error" in built) {
      return new Response(JSON.stringify({ error: built.error }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await runTask(built.task, { userId, prompt: built.prompt });
    // The answer's text only — never Claude's raw reply.
    return new Response(JSON.stringify({ text: result.text, model: result.model }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const timedOut = err instanceof AiError && err.kind === "timeout";
    console.error("[analyze-portfolio] failed:", err instanceof AiError ? `${err.kind}: ${err.message}` : (err as Error)?.name);
    return new Response(
      JSON.stringify({
        error: timedOut
          ? "The analysis took too long. Please try again."
          : "Analysis service temporarily unavailable. Please try again later.",
      }),
      { status: timedOut ? 504 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
