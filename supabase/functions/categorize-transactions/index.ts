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

const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

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

interface TxIn { id: string; description: string; amount: number; direction: string }

function buildPrompt(transactions: TxIn[], categories: string[]): string {
  return `You are categorising bank transactions for a personal finance ledger.

Assign each transaction exactly one category from this list, and nothing else:
${categories.map((c) => `- ${c}`).join("\n")}

Rules:
- Output ONLY a JSON array. No markdown, no commentary, no preamble.
- Each element: {"id":"<the id given>","category":"<one of the categories above>","confidence":<0 to 1>}
- Echo the "id" EXACTLY as given. Never invent, reorder or renumber ids.
- Return one element per input transaction. If you cannot tell, still return the element with your best category and a LOW confidence — do not omit it.
- "confidence" is your genuine certainty. Use below 0.5 when the description is opaque (a bare reference number, an unfamiliar acronym). Anything under the caller's threshold goes to a human, so a low score is useful, not a failure.
- Descriptions are Portuguese retail-bank text and are often abbreviated or truncated. Common forms: "COMPRAS C.DEB <merchant>" is a debit-card purchase; "LEVANTAMENTO"/"ATM" is a cash withdrawal; "TRF"/"TRANSF" is a transfer; "PAG SERVICOS" is a bill payment; "COMISSAO"/"IMPOSTO" are bank fees and taxes.
- A negative amount is money leaving the account, a positive amount is money arriving. Never assign a spending category to money arriving.

Transactions:
${JSON.stringify(transactions)}`;
}

async function callGemini(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE secret not set on the server.");
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // Deterministic: the same statement must extract identically every time,
      // or a re-import silently produces different rows.
      //
      // Thinking is disabled and the output budget raised because this is a
      // 2.5-series model: thinking tokens are charged against maxOutputTokens,
      // so a long section could exhaust the budget mid-JSON and come back
      // truncated. Transcription needs no reasoning, and paying for it here
      // bought a silent failure mode.
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  // A truncated answer must fail loudly so the Claude fallback runs, rather
  // than yielding half a JSON array that parses to nothing.
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Gemini stopped early (${candidate.finishReason})`);
  }
  const parts = candidate?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

async function callClaude(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY secret not set on the server.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content ?? []).find((c: { type: string }) => c.type === "text")?.text ?? "";
}

/**
 * Models occasionally wrap JSON in fences or add a stray trailing comma.
 *
 * Throws rather than returning [] when the text cannot be parsed. "The model
 * said there are no transactions" and "the response was truncated mid-JSON" are
 * completely different facts, and collapsing them into an empty array made a
 * lost section of ~40 transactions look like a successful import of none.
 */
function parseRows(text: string): unknown[] {
  let s = (text || "").trim();
  if (!s) throw new Error("empty response from model");
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1) throw new Error(`no JSON array in response: ${s.slice(0, 200)}`);
  if (end === -1 || end < start) throw new Error(`response truncated before the array closed: ${s.slice(0, 200)}`);
  s = s.slice(start, end + 1).replace(/,\s*([\]}])/g, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (err) {
    throw new Error(`unparseable JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("model returned a non-array");
  return parsed;
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

  let body: { transactions?: TxIn[]; categories?: string[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const transactions = Array.isArray(body.transactions) ? body.transactions : [];
  const categories = Array.isArray(body.categories) ? body.categories.filter(Boolean) : [];
  if (!transactions.length) return jsonResponse({ error: "transactions is required" }, 400, corsHeaders);
  if (!categories.length) return jsonResponse({ error: "categories is required" }, 400, corsHeaders);
  if (transactions.length > MAX_BATCH) {
    return jsonResponse({ error: `Batch of ${transactions.length} exceeds ${MAX_BATCH} - split it client-side.` }, 413, corsHeaders);
  }

  const prompt = buildPrompt(transactions, categories);

  let text = "";
  let provider = "gemini";
  try {
    text = await callGemini(prompt);
  } catch (geminiErr) {
    console.error("[categorize-transactions] gemini failed:", geminiErr);
    provider = "claude";
    try {
      text = await callClaude(prompt);
    } catch (claudeErr) {
      console.error("[categorize-transactions] claude failed:", claudeErr);
      // Generic to the caller; details stay in the logs.
      return jsonResponse({ error: "Categorisation service is unavailable right now." }, 502, corsHeaders);
    }
  }

  let rows: unknown[];
  try {
    rows = parseRows(text);
  } catch (parseErr) {
    console.error("[categorize-transactions] unparseable model output:", parseErr);
    // 502, not 200-with-nothing: the client must be able to tell a section that
    // genuinely held no transactions from one that was lost.
    return jsonResponse(
      { error: `The categorisation service returned something unreadable (${(parseErr as Error).message.slice(0, 120)}).` },
      502, corsHeaders,
    );
  }
  return jsonResponse(
    { results: rows, provider, model: provider === "gemini" ? GEMINI_MODEL : CLAUDE_MODEL, asked: transactions.length },
    200, corsHeaders,
  );
});
