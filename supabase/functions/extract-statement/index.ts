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

const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

const MAX_TEXT_LENGTH = 15000;   // the client chunks to 12K; this is the hard stop

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

function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildPrompt(statementText: string, hint?: string): string {
  return `You are a precise bank-statement parser. Extract every completed MONEY MOVEMENT from the statement lines below.

Rules:
- Output ONLY a JSON array. No markdown, no commentary, no preamble.
- Each element: {"date":"YYYY-MM-DD","description":"<what it was>","amount":<signed number>,"currency":"<ISO code>","balance":<running balance or null>}
- "amount" is SIGNED: negative when money left the account, positive when it arrived. Never output the absolute value.
- "balance" is the running balance printed on that row, if the statement shows one. Use null when it does not. Do NOT invent it, and never put the balance in "amount".
- Amounts may use European formatting (1.234,56). Convert to a plain number: 1234.56.
- Some statements print only day and month. Use the statement period or header to resolve the year. If the year genuinely cannot be determined, omit that row rather than guessing.
- A statement may contain SEVERAL sections with different layouts (current account, card transactions, funds). Extract movements from all of them.
- IGNORE: opening/closing balance summaries, subtotals, interest-rate tables, legal or marketing text, page headers and footers, and anything that is not a single dated movement.
- If there are no movements, output [].
${hint ? "\nLayout note for this bank: " + hint + "\n" : ""}
Statement lines:
"""
${statementText}
"""`;
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
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
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

/** Models occasionally wrap JSON in fences or add a stray trailing comma. */
function parseRows(text: string): unknown[] {
  let s = (text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  s = s.slice(start, end + 1).replace(/,\s*([\]}])/g, "$1");
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

  let body: { statementText?: string; hint?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const statementText = (body.statementText || "").trim();
  if (!statementText) return jsonResponse({ error: "statementText is required" }, 400, corsHeaders);
  if (statementText.length > MAX_TEXT_LENGTH) {
    return jsonResponse(
      { error: `statementText exceeds ${MAX_TEXT_LENGTH} characters - chunk it client-side.` },
      413, corsHeaders,
    );
  }

  const prompt = buildPrompt(statementText, body.hint);

  let text = "";
  let provider = "gemini";
  try {
    text = await callGemini(prompt);
  } catch (geminiErr) {
    console.error("[extract-statement] gemini failed:", geminiErr);
    provider = "claude";
    try {
      text = await callClaude(prompt);
    } catch (claudeErr) {
      console.error("[extract-statement] claude failed:", claudeErr);
      // Generic to the caller; details stay in the logs.
      return jsonResponse({ error: "Extraction service is unavailable right now." }, 502, corsHeaders);
    }
  }

  const rows = parseRows(text);
  return jsonResponse({ rows, provider, model: provider === "gemini" ? GEMINI_MODEL : CLAUDE_MODEL }, 200, corsHeaders);
});
