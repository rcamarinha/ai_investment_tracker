/**
 * Supabase Edge Function — Wine AI
 *
 * Routes AI requests for the Wine Cellar Tracker:
 *
 *   label           → Gemini Vision (primary) → Claude Vision fallback
 *   valuation       → Gemini (Google Search grounding) → Claude fallback
 *   batch-valuation → one Gemini call per chunk (the page sends one bottle) → Claude fallback
 *   analysis        → Gemini (Google Search grounding) → Claude fallback
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY_Wine  — used for label fallback, analysis fallback, and valuation fallback
 *   GEMINI_WINE             — used for label (primary) and valuation (primary); skipped if unset
 *
 * Request body:
 *   {
 *     requestType: "label" | "valuation" | "batch-valuation" | "analysis",
 *     prompt?: string,           // required for label / valuation / analysis
 *     image?: { base64, mediaType }, // label only
 *     maxTokens?: number,
 *     enableWebSearch?: boolean, // Claude web search (analysis only)
 *     bottles?: BottleInfo[],    // batch-valuation only
 *   }
 *
 * Response shape:
 *   label    → { content: [{type:"text", text:...}], _source: "gemini"|"claude" }
 *   analysis → { content: [{type:"text", text:...}], _source: "gemini"|"claude" }
 *   valuation        → { text: string, _geminiGrounding?: [...], _fallback?: "claude" }
 *   batch-valuation  → { results: ValuationResult[] }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordUsage } from "../_shared/usage.ts";
import {
  buildBatchPrompt, parseBatchText, padResults, geminiSearchCount, claudeSearchCount,
  markUnsearched, VALUATION_SYSTEM_INSTRUCTION,
} from "../_shared/wine-batch-core.js";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY_Wine");
const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

// 3.5 rather than 2.5: from 21 September every grounded 2.5 valuation hit the
// 20s limit, while nothing in the request had changed, and 2.5 is on Google's
// retirement path. 3.5 costs about five times as much per token.
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Sonnet, not Opus: a price looked up from a few shop listings does not need
// the largest model, and the fallback now carries most valuations. Opus read
// ~115K tokens per bottle at $5/M input; Sonnet 4.6 is $3/M and faster.
const CLAUDE_MODEL = "claude-sonnet-4-6";

// Time budget for one request, inside the browser's 115s wait (wine/api.js)
// and Supabase's 150s limit: Gemini first, then the Claude fallback. Gemini
// had 20s until 21 September, when every grounded call — 2.5 and 3.5 alike —
// timed out at exactly 20s; the timing log shows what it really needs.
const GEMINI_TIMEOUT_MS = 45_000;
const CLAUDE_TIMEOUT_MS = 60_000;
// Thinking, not searching, is where a valuation's time goes: a measured call
// thought for 4986 tokens to write a 243-token answer, taking 38s. "low" asks
// for less. Google's docs do not say which levels 3.5 Flash accepts, so a
// request it rejects is repeated once without the setting, and the setting is
// then dropped for the life of this instance (see thinkingLevelRefused).
const VALUATION_THINKING_LEVEL = "low";
// Gemini's thinking counts against its output limit: one measured single-bottle
// valuation spent 2896 of 4096 on thinking and 192 on the answer, so a batch of
// three was one long think away from being cut off — which fails to parse and
// falls back to Claude. Billed on what is generated, so headroom is free.
const GEMINI_VALUATION_TOKENS = 8192;
// Web searches the Claude fallback may run: one bottle, or one chunk of three.
const SEARCHES_SINGLE = 5;
const SEARCHES_BATCH = 8;


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

function jsonResponse(data: unknown, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Gemini helper ─────────────────────────────────────────────────────────────

// Records one upstream call against the person who made the request. Passed
// down explicitly rather than held in a module variable: one isolate serves
// concurrent requests, so a module-level "current user" could credit one
// person's call to another. Every attempt is recorded, refused ones included.
type Meter = (provider: string, model: string, ok: boolean, response?: unknown) => void;

interface GeminiResult {
  text: string;
  groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
  searches: number;
}

interface GeminiOpts {
  systemInstruction?: string;
  /** This attempt's time limit; defaults to GEMINI_TIMEOUT_MS. */
  timeoutMs?: number;
  /** generationConfig.thinkingConfig.thinkingLevel, e.g. "low". */
  thinkingLevel?: string;
}

// Set once Gemini rejects the thinking level, so later requests on this
// instance stop paying for a refused call. Not per-user state: it records what
// the model accepts, which is the same for everyone.
let thinkingLevelRefused = false;

async function _callGeminiOnce(
  prompt: string,
  maxTokens: number,
  useGrounding: boolean,
  meter: Meter,
  opts: GeminiOpts = {},
): Promise<GeminiResult & { usedGrounding: boolean }> {
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const thinkingLevel = thinkingLevelRefused ? undefined : opts.thinkingLevel;
  const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }

  // Hard limit per Gemini call (GEMINI_TIMEOUT_MS) so the Claude fallback can
  // still run within the browser's wait. Grounded searches stall; without this the
  // whole edge-function invocation hangs until the client aborts the request.
  // Timing is logged for every attempt, so a slow or stalled Gemini shows in the
  // function logs as a number rather than a guess: how long, grounded or not,
  // how it finished, and how much of the output budget went on thinking.
  const started = Date.now();
  const mode = (useGrounding ? "grounded" : "ungrounded") + (thinkingLevel ? ` thinking=${thinkingLevel}` : "");
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      // Key in a header, not the URL: Deno puts the full URL in network error
      // messages, and those are logged, so a ?key= URL leaks the key into logs.
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY ?? "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A timeout used to leave no usage row at all, so every fallback to Claude
    // looked, in usage_events, like Claude had been chosen first.
    meter("gemini", GEMINI_MODEL, false);
    const name = err instanceof Error ? err.name : "Error";
    console.warn(`[wine-ai] Gemini ${GEMINI_MODEL} ${mode}: ${name} after ${Date.now() - started}ms`);
    throw err;
  }

  if (!res.ok) {
    meter("gemini", GEMINI_MODEL, false);
    console.warn(`[wine-ai] Gemini ${GEMINI_MODEL} ${mode}: HTTP ${res.status} after ${Date.now() - started}ms`);
    const errText = await res.text().catch(() => "");
    // The thinking level is a guess about what 3.5 Flash accepts. If Google
    // rejects it, repeat once without it rather than hand the bottle to Claude.
    const left = timeoutMs - (Date.now() - started);
    if (thinkingLevel && res.status === 400 && /thinking/i.test(errText) && left > 5_000) {
      thinkingLevelRefused = true;
      console.warn(`[wine-ai] Gemini refused thinkingLevel=${thinkingLevel}; repeating without it:`, errText.slice(0, 200));
      return _callGeminiOnce(prompt, maxTokens, useGrounding, meter, { ...opts, thinkingLevel: undefined, timeoutMs: left });
    }
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  meter("gemini", GEMINI_MODEL, true, data);
  const u = data.usageMetadata ?? {};
  console.log(
    `[wine-ai] Gemini ${GEMINI_MODEL} ${mode}: ${Date.now() - started}ms,` +
    ` finish=${data.candidates?.[0]?.finishReason ?? "none"},` +
    ` searches=${geminiSearchCount(data)},` +
    ` in=${u.promptTokenCount ?? "?"} out=${u.candidatesTokenCount ?? "?"} thinking=${u.thoughtsTokenCount ?? 0}/${maxTokens}`,
  );
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("");
  const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? undefined;
  return { text, groundingChunks, searches: geminiSearchCount(data), usedGrounding: useGrounding };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Gemini for a valuation: grounded, search-first system instruction, low
 * thinking. Whether it searched is reported, not required — Gemini decides for
 * itself, and the caller marks an unsearched answer (markUnsearched) instead of
 * sending the bottle to Claude. One attempt, so Gemini (45s) plus the Claude
 * fallback (60s) fits the page's 115s wait.
 */
function callGeminiValuation(prompt: string, maxTokens: number, meter: Meter): Promise<GeminiResult> {
  return callGemini(prompt, maxTokens, meter, false, {
    systemInstruction: VALUATION_SYSTEM_INSTRUCTION,
    thinkingLevel: VALUATION_THINKING_LEVEL,
  });
}

/**
 * Call Gemini with Google Search grounding (default).
 * On 429 (grounding quota exceeded), waits briefly then retries without grounding —
 * unless allowUngrounded is false (valuations), when it throws for the fallback.
 * If the ungrounded attempt also fails with 429, waits and retries once more.
 * If all attempts fail, throws — meaning the Gemini key is dead or exhausted.
 */
async function callGemini(
  prompt: string,
  maxTokens: number,
  meter: Meter,
  allowUngrounded = true,
  opts: GeminiOpts = {},
): Promise<GeminiResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE secret not set on the server.");

  // Attempt 1: with Google Search grounding (default)
  try {
    console.log("[wine-ai] Gemini grounded request (with Google Search)");
    const result = await _callGeminiOnce(prompt, maxTokens, true, meter, opts);
    console.log("[wine-ai] Gemini: grounded response OK");
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("429")) throw err; // non-quota error → propagate immediately
    // A price the model recalls from memory is a guess stored as a valuation, and
    // it reaches net worth on the hub. Valuations refuse it and go to Claude,
    // which searches; cellar analysis can still use an unsearched answer.
    if (!allowUngrounded) throw err;
    console.warn("[wine-ai] Gemini grounding quota hit (429), waiting 2s then retrying without Google Search...");
    await sleep(2000);
  }

  // Attempt 2: without grounding (bypasses grounding quota)
  try {
    console.log("[wine-ai] Gemini ungrounded request (no Google Search)");
    const result = await _callGeminiOnce(prompt, maxTokens, false, meter);
    console.log("[wine-ai] Gemini: ungrounded response OK");
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("429")) throw err;
    console.warn("[wine-ai] Gemini ungrounded also 429, waiting 5s then making one final attempt...");
    await sleep(5000);
  }

  // Attempt 3: final retry without grounding
  console.log("[wine-ai] Gemini final ungrounded retry");
  const result = await _callGeminiOnce(prompt, maxTokens, false, meter);
  console.log("[wine-ai] Gemini: final retry OK");
  return result;
}

// ── Gemini Vision helper ──────────────────────────────────────────────────────

/**
 * Send an image + text prompt to Gemini Vision and return the text response.
 * Uses the same GEMINI_WINE key as the text/grounding calls.
 */
async function callGeminiVision(
  prompt: string,
  imageBase64: string,
  mediaType: string,
  maxTokens: number,
  meter: Meter,
): Promise<{ text: string }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE secret not set on the server.");

  const body = {
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mediaType, data: imageBase64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens },
  };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    // Key in a header, not the URL: Deno puts the full URL in network error
    // messages, and those are logged, so a ?key= URL leaks the key into logs.
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY ?? "" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    meter("gemini", GEMINI_MODEL, false);
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini Vision API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  meter("gemini", GEMINI_MODEL, true, data);
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("");
  return { text };
}

// ── Claude text helper ────────────────────────────────────────────────────────

async function callClaude(
  prompt: string,
  maxTokens: number,
  useWebSearch: boolean,
  meter: Meter,
  maxSearches = SEARCHES_SINGLE,
): Promise<{ text: string; searches: number }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY_Wine secret not set on the server.");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };

  const reqBody: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };

  if (useWebSearch) {
    headers["anthropic-beta"] = "web-search-2025-03-05";
    // Capped: uncapped, a single valuation ran 7-16 searches and read up to
    // 440K input tokens, which took it past the browser's limit — paid for,
    // then discarded. The pricing rules ask for three sources; this leaves room.
    reqBody.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }];
  }

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    });
  } catch (err) {
    meter("anthropic", CLAUDE_MODEL, false);
    throw err;
  }

  if (!res.ok) {
    meter("anthropic", CLAUDE_MODEL, false);
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  meter("anthropic", CLAUDE_MODEL, true, data);
  const text = ((data.content ?? []) as Array<{ type: string; text?: string }>)
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("");

  return { text, searches: claudeSearchCount(data) };
}

// ── Single-bottle valuation: Gemini → Claude fallback ─────────────────────────

/**
 * Mark an unsearched single valuation inside its JSON text, which the page
 * parses. Text that cannot be read is passed through untouched: the page
 * reports it, as before.
 */
function markSingle(text: string, searched: boolean): string {
  const parsed = parseBatchText(text, [{ id: "single" }]);
  const r = parsed?.results[0];
  if (!r) return text;
  const { id: _id, ...result } = markUnsearched(r, searched);
  return JSON.stringify(result);
}

async function handleValuation(prompt: string, corsHeaders: Record<string, string>, meter: Meter): Promise<Response> {
  let geminiError = "";

  // 1. Try Gemini (with Google Search grounding)
  try {
    const { text, groundingChunks, searches } = await callGeminiValuation(prompt, GEMINI_VALUATION_TOKENS, meter);
    if (text.trim()) {
      console.log(`[wine-ai] Valuation via Gemini (${searches ? `${searches} searches` : "no search"})`);
      return jsonResponse(
        { text: markSingle(text, searches > 0), _geminiGrounding: groundingChunks ?? null, _searched: searches > 0 },
        200, corsHeaders,
      );
    }
    // Gemini returned empty content (can happen when grounding search stalls or
    // candidates[0].content.parts is empty) — treat as failure and use Claude.
    geminiError = "Gemini returned empty response (no text content)";
    console.warn("[wine-ai] Gemini valuation returned empty text, falling back to Claude");
  } catch (err) {
    geminiError = err instanceof Error ? err.message : String(err);
    const is429 = geminiError.includes("429");
    const isTimeout = geminiError.toLowerCase().includes("timeout") || geminiError.toLowerCase().includes("abort");
    console.warn(`[wine-ai] Gemini valuation ${is429 ? "quota (429)" : isTimeout ? "timed out" : "failed"}, falling back to Claude:`, geminiError);
  }

  // 2. Fallback: Claude with web search
  try {
    const { text, searches } = await callClaude(prompt, 4096, true, meter);
    console.log(`[wine-ai] Valuation via Claude (fallback, ${searches ? `${searches} searches` : "no search"})`);
    return jsonResponse(
      { text: markSingle(text, searches > 0), _geminiGrounding: null, _fallback: "claude", _geminiError: geminiError, _searched: searches > 0 },
      200, corsHeaders,
    );
  } catch (err) {
    const claudeMsg = err instanceof Error ? err.message : String(err);
    console.error("[wine-ai] Claude fallback also failed:", claudeMsg);
    return jsonResponse(
      { error: "Valuation service temporarily unavailable. Please try again later." },
      502, corsHeaders
    );
  }
}

// ── Batch valuation: Gemini → Claude fallback per chunk ───────────────────────

interface BottleInfo {
  id?: string;
  name?: string;
  winery?: string;
  vintage?: number | string;
  region?: string;
  appellation?: string;
  varietal?: string;
  country?: string;
  purchasePrice?: number;
  notes?: string;
  bottleSize?: string;
}

interface ValuationResult {
  id?: string;
  estimatedValue?: number;
  estimatedValueUSD?: number;
  valueLow?: number;
  valueHigh?: number;
  drinkWindow?: string | null;
  confidence?: string;
  sources?: string;
  valuationNote?: string;
  error?: string;
}

// Chunk size for Gemini grounding. The page sends one bottle per request, so a
// chunk is normally one bottle; this caps what a direct caller can bundle.
const CHUNK_SIZE = 3;

async function valuateChunk(chunk: BottleInfo[], chunkIdx: number, meter: Meter): Promise<ValuationResult[]> {
  const prompt = buildBatchPrompt(chunk);
  const maxTokens = GEMINI_VALUATION_TOKENS; // thinking + ~500 tokens per bottle

  // Each provider's answer is matched to bottles by the ref it names, never by
  // position (see _shared/wine-batch-core.js); a bottle nothing names gets an
  // explicit error rather than a neighbour's price.
  const accept = (text: string, source: string, searched: boolean): ValuationResult[] | null => {
    const parsed = parseBatchText(text, chunk);
    if (!parsed) {
      console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): no readable JSON. Snippet:`, text.slice(0, 200));
      return null;
    }
    if (parsed.unmatched) {
      console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): ${parsed.unmatched} result(s) named no bottle in this chunk and were dropped`);
    }
    console.log(`[wine-ai] Chunk ${chunkIdx}: ${source} OK (${parsed.results.length}/${chunk.length} matched, ${searched ? "searched" : "no search"})`);
    return padResults(parsed.results.map(r => markUnsearched(r, searched)), chunk, source) as ValuationResult[];
  };

  // 1. Gemini. It is asked to search; if it did not, the results say so.
  try {
    const { text, searches } = await callGeminiValuation(prompt, maxTokens, meter);
    const results = accept(text, "Gemini", searches > 0);
    if (results) return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wine-ai] Chunk ${chunkIdx}: Gemini failed — ${msg}`);
  }

  // 2. Fallback: Claude
  console.log(`[wine-ai] Chunk ${chunkIdx}: falling back to Claude`);
  const searches = chunk.length === 1 ? SEARCHES_SINGLE : SEARCHES_BATCH;
  const claude = await callClaude(prompt, maxTokens, true, meter, searches);
  const results = accept(claude.text, "Claude", claude.searches > 0);
  if (results) return results;

  // Both failed — return error stubs so other chunks still succeed
  console.error(`[wine-ai] Chunk ${chunkIdx}: both Gemini and Claude failed`);
  return chunk.map(b => ({ id: b.id, error: "No valid JSON from Gemini or Claude" } as ValuationResult));
}

async function handleBatchValuation(bottles: BottleInfo[], corsHeaders: Record<string, string>, meter: Meter): Promise<Response> {
  if (!bottles || bottles.length === 0) {
    return jsonResponse({ error: "bottles array is empty" }, 400, corsHeaders);
  }

  // Split into fixed-size chunks
  const chunks: BottleInfo[][] = [];
  for (let i = 0; i < bottles.length; i += CHUNK_SIZE) {
    chunks.push(bottles.slice(i, i + CHUNK_SIZE));
  }

  console.log(`[wine-ai] Batch: ${bottles.length} bottle(s) → ${chunks.length} chunk(s) of ≤${CHUNK_SIZE}, running sequentially`);

  // Inter-chunk delay to avoid hitting Gemini grounding rate limits on large batches.
  // Gemini grounded searches are subject to per-minute quotas; a short pause between
  // chunks prevents the cascade where Gemini 429s trigger expensive Claude fallbacks.
  const INTER_CHUNK_DELAY_MS = 1500;

  // Process chunks sequentially to avoid exhausting Supabase worker resources
  // (concurrent outgoing connections + CPU/memory) on large lists.
  const results: ValuationResult[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    if (idx > 0) await sleep(INTER_CHUNK_DELAY_MS);
    try {
      const chunkResults = await valuateChunk(chunks[idx], idx, meter);
      results.push(...chunkResults);
    } catch (err) {
      // Whole chunk threw unexpectedly — fill with error stubs and keep going
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wine-ai] Chunk ${idx} rejected:`, msg);
      chunks[idx].forEach(b => results.push({ id: b.id, error: msg } as ValuationResult));
    }
  }

  return jsonResponse({ results }, 200, corsHeaders);
}

// ── Label recognition: Gemini Vision primary, Claude Vision fallback ──────────

/**
 * Handles the "label" requestType.
 * 1. Tries Gemini Vision (if GEMINI_WINE is set and an image is provided).
 * 2. Falls back to Claude Vision on any Gemini error.
 * Always returns { content: [{type:"text", text}], _source: "gemini"|"claude" }
 * so the client-side parser (`data.content?.find(c => c.type === 'text')?.text`)
 * works identically regardless of which model answered.
 */
async function handleLabel(
  prompt: string,
  image: { base64: string; mediaType: string } | undefined,
  maxTokens: number,
  corsHeaders: Record<string, string>,
  meter: Meter,
): Promise<Response> {
  // 1. Try Gemini Vision (primary)
  if (GEMINI_API_KEY && image?.base64) {
    try {
      console.log("[wine-ai] Label recognition via Gemini Vision (primary)");
      const { text } = await callGeminiVision(
        prompt,
        image.base64,
        image.mediaType || "image/jpeg",
        maxTokens,
        meter,
      );
      console.log("[wine-ai] Label: Gemini Vision OK");
      // Normalise to the same shape as the Claude response so the client needs no changes
      return jsonResponse({ content: [{ type: "text", text }], _source: "gemini" }, 200, corsHeaders);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[wine-ai] Gemini Vision failed, falling back to Claude Vision:", msg);
    }
  }

  // 2. Fallback: Claude Vision
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY_Wine is not set on the server." }, 500, corsHeaders);
  }

  console.log("[wine-ai] Label recognition via Claude Vision (fallback)");

  type ImagePart = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
  type TextPart  = { type: "text"; text: string };
  const content: string | Array<ImagePart | TextPart> = image?.base64
    ? [
        { type: "image", source: { type: "base64", media_type: image.mediaType || "image/jpeg", data: image.base64 } },
        { type: "text", text: prompt },
      ]
    : prompt;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });

  if (!anthropicRes.ok) {
    meter("anthropic", CLAUDE_MODEL, false);
    const errBody = await anthropicRes.text().catch(() => "");
    console.error(`[wine-ai] Anthropic API error ${anthropicRes.status}:`, errBody.slice(0, 300));
    return jsonResponse(
      { error: "AI service temporarily unavailable. Please try again later." },
      502, corsHeaders,
    );
  }

  const data = await anthropicRes.json();
  meter("anthropic", CLAUDE_MODEL, true, data);
  return jsonResponse({ ...data, _source: "claude" }, 200, corsHeaders);
}

// ── Cellar analysis: Gemini primary (grounded), Claude fallback ───────────────

async function handleAnalysis(prompt: string, maxTokens: number, corsHeaders: Record<string, string>, meter: Meter): Promise<Response> {
  let geminiError = "";

  // 1. Try Gemini with Google Search grounding
  if (GEMINI_API_KEY) {
    try {
      console.log("[wine-ai] Cellar analysis via Gemini (primary)");
      const { text } = await callGemini(prompt, maxTokens, meter);
      return jsonResponse({ content: [{ type: "text", text }], _source: "gemini" }, 200, corsHeaders);
    } catch (err) {
      geminiError = err instanceof Error ? err.message : String(err);
      console.warn("[wine-ai] Gemini analysis failed, falling back to Claude:", geminiError);
    }
  }

  // 2. Fallback: Claude
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Neither GEMINI_WINE nor ANTHROPIC_API_KEY_Wine is available." }, 500, corsHeaders);
  }

  try {
    console.log("[wine-ai] Cellar analysis via Claude (fallback)");
    const { text } = await callClaude(prompt, maxTokens, false, meter);
    return jsonResponse({ content: [{ type: "text", text }], _source: "claude" }, 200, corsHeaders);
  } catch (err) {
    const claudeMsg = err instanceof Error ? err.message : String(err);
    console.error("[wine-ai] Claude analysis fallback also failed:", claudeMsg);
    return jsonResponse(
      { error: "Analysis service temporarily unavailable. Please try again later." },
      502, corsHeaders,
    );
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Manual auth verification ─────────────────────────────────────────────
  // Gateway verify_jwt is off (incompatible with sb_publishable_ keys / ES256),
  // so we validate the user token ourselves via Supabase Auth.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ error: "Missing authorization token" }, 401, corsHeaders);
  }
  // The verified caller, for recording usage — never taken from the request body.
  let userId = "";
  {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      console.warn("[wine-ai] Auth failed:", error?.message || "no user");
      return jsonResponse({ error: "Invalid or expired token. Please log in again." }, 401, corsHeaders);
    }
    console.log("[wine-ai] Authenticated user:", data.user.id);
    userId = data.user.id;
  }
  const meter: Meter = (provider, model, ok, response) =>
    recordUsage({ userId, fn: "wine-ai", provider, model, ok, response });

  let body: {
    requestType: string;
    prompt?: string;
    image?: { base64: string; mediaType: string };
    maxTokens?: number;
    enableWebSearch?: boolean;
    bottles?: BottleInfo[];
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const { requestType, prompt, image, enableWebSearch = false, bottles } = body;
  // Cap maxTokens server-side to prevent abuse
  const maxTokens = Math.min(body.maxTokens || 1024, 8192);

  if (!requestType) {
    return jsonResponse({ error: "requestType is required" }, 400, corsHeaders);
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const MAX_PROMPT_LENGTH  = 15_000;
  // One chunk per request: chunks run one after another, and each can take a
  // Gemini try plus a Claude fallback, so more than one cannot finish inside
  // Supabase's 150s. It also caps what one request can spend.
  const MAX_BATCH_SIZE     = CHUNK_SIZE;
  const MAX_IMAGE_BASE64   = 2 * 1024 * 1024; // 2 MB

  if (prompt && prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse({ error: `Prompt too long (max ${MAX_PROMPT_LENGTH} chars)` }, 400, corsHeaders);
  }
  if (image?.base64 && image.base64.length > MAX_IMAGE_BASE64) {
    return jsonResponse({ error: "Image too large (max 2 MB)" }, 400, corsHeaders);
  }

  // ── Valuation routes (Gemini primary, Claude fallback) ───────────────────
  if (requestType === "valuation") {
    if (!prompt) return jsonResponse({ error: "prompt is required for valuation" }, 400, corsHeaders);
    return handleValuation(prompt, corsHeaders, meter);
  }

  if (requestType === "batch-valuation") {
    if (!Array.isArray(bottles) || bottles.length === 0) {
      return jsonResponse({ error: "bottles array is required for batch-valuation" }, 400, corsHeaders);
    }
    if (bottles.length > MAX_BATCH_SIZE) {
      return jsonResponse({ error: `Too many bottles (max ${MAX_BATCH_SIZE} per request)` }, 400, corsHeaders);
    }
    return handleBatchValuation(bottles, corsHeaders, meter);
  }

  // ── Label route (Gemini Vision primary, Claude Vision fallback) ───────────
  if (requestType === "label") {
    if (!prompt) return jsonResponse({ error: "prompt is required for label" }, 400, corsHeaders);
    return handleLabel(prompt, image, maxTokens, corsHeaders, meter);
  }

  // ── Analysis route (Gemini primary, Claude fallback) ─────────────────────
  if (requestType === "analysis") {
    if (!prompt) return jsonResponse({ error: "prompt is required for analysis" }, 400, corsHeaders);
    return handleAnalysis(prompt, maxTokens, corsHeaders, meter);
  }

  return jsonResponse({ error: `Unknown requestType: ${requestType}` }, 400, corsHeaders);
});
