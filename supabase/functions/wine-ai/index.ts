/**
 * Supabase Edge Function — Wine AI
 *
 * Routes AI requests for the Wine Cellar Tracker:
 *
 *   label           → Gemini Vision (primary) → Claude Vision fallback
 *   valuation       → Gemini (Google Search grounding) → Claude fallback
 *   batch-valuation → Gemini chunked 5 at a time (parallel) → Claude fallback per chunk
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

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY_Wine");
const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CLAUDE_MODEL = "claude-opus-4-6";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Gemini helper ─────────────────────────────────────────────────────────────

interface GeminiResult {
  text: string;
  groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
}

async function _callGeminiOnce(prompt: string, maxTokens: number, useGrounding: boolean): Promise<GeminiResult & { usedGrounding: boolean }> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("");
  const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? undefined;
  return { text, groundingChunks, usedGrounding: useGrounding };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Call Gemini with Google Search grounding (default).
 * On 429 (grounding quota exceeded), waits briefly then retries without grounding.
 * If the ungrounded attempt also fails with 429, waits and retries once more.
 * If all attempts fail, throws — meaning the Gemini key is dead or exhausted.
 */
async function callGemini(prompt: string, maxTokens = 4096): Promise<GeminiResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE secret not set on the server.");

  // Attempt 1: with Google Search grounding (default)
  try {
    console.log("[wine-ai] Gemini grounded request (with Google Search)");
    const result = await _callGeminiOnce(prompt, maxTokens, true);
    console.log("[wine-ai] Gemini: grounded response OK");
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("429")) throw err; // non-quota error → propagate immediately
    console.warn("[wine-ai] Gemini grounding quota hit (429), waiting 2s then retrying without Google Search...");
    await sleep(2000);
  }

  // Attempt 2: without grounding (bypasses grounding quota)
  try {
    console.log("[wine-ai] Gemini ungrounded request (no Google Search)");
    const result = await _callGeminiOnce(prompt, maxTokens, false);
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
  const result = await _callGeminiOnce(prompt, maxTokens, false);
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
  maxTokens = 1024,
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

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini Vision API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("");
  return { text };
}

// ── Claude text helper ────────────────────────────────────────────────────────

async function callClaude(prompt: string, maxTokens = 4096, useWebSearch = true): Promise<{ text: string }> {
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
    reqBody.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = ((data.content ?? []) as Array<{ type: string; text?: string }>)
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("");

  return { text };
}

// ── Single-bottle valuation: Gemini → Claude fallback ─────────────────────────

async function handleValuation(prompt: string): Promise<Response> {
  let geminiError = "";

  // 1. Try Gemini (with Google Search grounding)
  try {
    const { text, groundingChunks } = await callGemini(prompt, 4096);
    console.log("[wine-ai] Valuation via Gemini");
    return jsonResponse({ text, _geminiGrounding: groundingChunks ?? null });
  } catch (err) {
    geminiError = err instanceof Error ? err.message : String(err);
    const is429 = geminiError.includes("429");
    console.warn(`[wine-ai] Gemini valuation ${is429 ? "quota exceeded (429)" : "failed"}, falling back to Claude:`, geminiError);
  }

  // 2. Fallback: Claude with web search
  try {
    const { text } = await callClaude(prompt, 4096, true);
    console.log("[wine-ai] Valuation via Claude (fallback)");
    return jsonResponse({ text, _geminiGrounding: null, _fallback: "claude", _geminiError: geminiError });
  } catch (err) {
    const claudeMsg = err instanceof Error ? err.message : String(err);
    console.error("[wine-ai] Claude fallback also failed:", claudeMsg);
    return jsonResponse(
      { error: `Gemini failed: ${geminiError}; Claude fallback failed: ${claudeMsg}` },
      502
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

function buildBatchPrompt(bottles: BottleInfo[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = bottles.map((b, i) => {
    const fields = [
      b.name        && `Wine name: ${b.name}`,
      b.winery      && `Winery/Producer: ${b.winery}`,
      b.vintage     && `Vintage: ${b.vintage}`,
      b.region      && `Region: ${b.region}`,
      b.appellation && `Appellation: ${b.appellation}`,
      b.varietal    && `Grape variety: ${b.varietal}`,
      b.country     && `Country: ${b.country}`,
      b.purchasePrice && `Purchase price: €${b.purchasePrice}/bottle`,
    ].filter(Boolean).join(", ");
    return `${i + 1}. ${fields || "(unknown wine)"}`;
  }).join("\n");

  return `You are a wine investment expert. Use web search to find current retail and auction market prices for each wine below, then return valuations.

Today's date: ${today}

Wines to value:
${lines}

Return a JSON array with exactly ${bottles.length} objects, one per wine, in the same order. Each object must have:
{
  "estimatedValue": <EUR per 750ml, number>,
  "estimatedValueUSD": <USD per 750ml, number>,
  "valueLow": <low end EUR, number>,
  "valueHigh": <high end EUR, number>,
  "drinkWindow": <"YYYY-YYYY" or null>,
  "confidence": <"high"|"medium"|"low">,
  "sources": <brief citation string>,
  "valuationNote": <1-2 sentence explanation>
}

Rules:
- Be vintage-specific (do NOT average across years).
- If you cannot find data for a wine, use low confidence and estimate conservatively.
- Return ONLY the JSON array. No markdown fences, no preamble.`;
}

/** Sanitise common Gemini JSON quirks before parsing. */
function sanitiseJson(s: string): string {
  return s
    .replace(/```json\s*/gi, "").replace(/```\s*/g, "") // strip markdown fences
    .replace(/\bNone\b/g, "null")                       // Python-style None
    .replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false")
    .replace(/,(\s*[}\]])/g, "$1");                     // trailing commas
}

/** Parse a JSON array of ValuationResult from an AI response text. Returns null on failure. */
function parseBatchText(
  text: string,
  chunk: BottleInfo[],
  chunkIdx: number,
  source: string
): ValuationResult[] | null {
  const clean = sanitiseJson(text);

  // 1. Try JSON array [...]
  const arrayMatch = clean.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed: ValuationResult[] = JSON.parse(arrayMatch[0]);
      return parsed.map((r, i) => ({ ...r, id: chunk[i]?.id }));
    } catch {
      console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): array JSON parse failed, trying object fallback`);
    }
  } else {
    console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): no JSON array found. Snippet:`, text.slice(0, 200));
  }

  // 2. Object fallback {...} — Gemini sometimes returns a bare object for single-wine batches
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed: ValuationResult = JSON.parse(objMatch[0]);
      console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): recovered single object as array`);
      return [{ ...parsed, id: chunk[0]?.id }];
    } catch {
      console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): object fallback parse also failed`);
    }
  }

  return null;
}

// Optimal chunk size for Gemini grounding: small enough for focused per-wine
// web searches, large enough to keep parallel API calls manageable.
const CHUNK_SIZE = 5;

async function valuateChunk(chunk: BottleInfo[], chunkIdx: number): Promise<ValuationResult[]> {
  const prompt = buildBatchPrompt(chunk);
  const maxTokens = 4096; // 5 bottles × ~500 tokens each — well within limit

  // 1. Try Gemini
  try {
    const { text } = await callGemini(prompt, maxTokens);
    const parsed = parseBatchText(text, chunk, chunkIdx, "Gemini");
    if (parsed) {
      console.log(`[wine-ai] Chunk ${chunkIdx}: Gemini OK (${parsed.length} results)`);
      return parsed;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wine-ai] Chunk ${chunkIdx}: Gemini failed — ${msg}`);
  }

  // 2. Fallback: Claude
  console.log(`[wine-ai] Chunk ${chunkIdx}: falling back to Claude`);
  const { text } = await callClaude(prompt, maxTokens, true);
  const parsed = parseBatchText(text, chunk, chunkIdx, "Claude");
  if (parsed) {
    console.log(`[wine-ai] Chunk ${chunkIdx}: Claude fallback OK (${parsed.length} results)`);
    return parsed;
  }

  // Both failed — return error stubs so other chunks still succeed
  console.error(`[wine-ai] Chunk ${chunkIdx}: both Gemini and Claude failed`);
  return chunk.map(b => ({ id: b.id, error: "No valid JSON from Gemini or Claude" } as ValuationResult));
}

async function handleBatchValuation(bottles: BottleInfo[]): Promise<Response> {
  if (!bottles || bottles.length === 0) {
    return jsonResponse({ error: "bottles array is empty" }, 400);
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
      const chunkResults = await valuateChunk(chunks[idx], idx);
      results.push(...chunkResults);
    } catch (err) {
      // Whole chunk threw unexpectedly — fill with error stubs and keep going
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wine-ai] Chunk ${idx} rejected:`, msg);
      chunks[idx].forEach(b => results.push({ id: b.id, error: msg } as ValuationResult));
    }
  }

  return jsonResponse({ results });
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
      );
      console.log("[wine-ai] Label: Gemini Vision OK");
      // Normalise to the same shape as the Claude response so the client needs no changes
      return jsonResponse({ content: [{ type: "text", text }], _source: "gemini" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[wine-ai] Gemini Vision failed, falling back to Claude Vision:", msg);
    }
  }

  // 2. Fallback: Claude Vision
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY_Wine is not set on the server." }, 500);
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
    const errBody = await anthropicRes.text().catch(() => "");
    return jsonResponse(
      { error: `Anthropic API error: ${anthropicRes.status}`, details: errBody.slice(0, 300) },
      anthropicRes.status,
    );
  }

  const data = await anthropicRes.json();
  return jsonResponse({ ...data, _source: "claude" });
}

// ── Cellar analysis: Gemini primary (grounded), Claude fallback ───────────────

async function handleAnalysis(prompt: string, maxTokens: number): Promise<Response> {
  let geminiError = "";

  // 1. Try Gemini with Google Search grounding
  if (GEMINI_API_KEY) {
    try {
      console.log("[wine-ai] Cellar analysis via Gemini (primary)");
      const { text } = await callGemini(prompt, maxTokens);
      return jsonResponse({ content: [{ type: "text", text }], _source: "gemini" });
    } catch (err) {
      geminiError = err instanceof Error ? err.message : String(err);
      console.warn("[wine-ai] Gemini analysis failed, falling back to Claude:", geminiError);
    }
  }

  // 2. Fallback: Claude
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Neither GEMINI_WINE nor ANTHROPIC_API_KEY_Wine is available." }, 500);
  }

  try {
    console.log("[wine-ai] Cellar analysis via Claude (fallback)");
    const { text } = await callClaude(prompt, maxTokens, false);
    return jsonResponse({ content: [{ type: "text", text }], _source: "claude", _geminiError: geminiError || undefined });
  } catch (err) {
    const claudeMsg = err instanceof Error ? err.message : String(err);
    console.error("[wine-ai] Claude analysis fallback also failed:", claudeMsg);
    return jsonResponse(
      { error: `Gemini failed: ${geminiError}; Claude fallback failed: ${claudeMsg}` },
      502,
    );
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

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
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { requestType, prompt, image, maxTokens = 1024, enableWebSearch = false, bottles } = body;

  if (!requestType) {
    return jsonResponse({ error: "requestType is required" }, 400);
  }

  // ── Valuation routes (Gemini primary, Claude fallback) ───────────────────
  if (requestType === "valuation") {
    if (!prompt) return jsonResponse({ error: "prompt is required for valuation" }, 400);
    return handleValuation(prompt);
  }

  if (requestType === "batch-valuation") {
    if (!Array.isArray(bottles) || bottles.length === 0) {
      return jsonResponse({ error: "bottles array is required for batch-valuation" }, 400);
    }
    return handleBatchValuation(bottles);
  }

  // ── Label route (Gemini Vision primary, Claude Vision fallback) ───────────
  if (requestType === "label") {
    if (!prompt) return jsonResponse({ error: "prompt is required for label" }, 400);
    return handleLabel(prompt, image, maxTokens);
  }

  // ── Analysis route (Gemini primary, Claude fallback) ─────────────────────
  if (requestType === "analysis") {
    if (!prompt) return jsonResponse({ error: "prompt is required for analysis" }, 400);
    return handleAnalysis(prompt, maxTokens);
  }

  return jsonResponse({ error: `Unknown requestType: ${requestType}` }, 400);
});
