/**
 * Supabase Edge Function — Wine AI
 *
 * Routes AI requests for the Wine Cellar Tracker:
 *
 *   label           → Claude (vision + text) for label recognition
 *   valuation       → Gemini (Google Search grounding) → Claude fallback
 *   batch-valuation → Gemini chunked 8 at a time → Claude fallback per chunk
 *   analysis        → Claude for cellar insights
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY_Wine  — used for label, analysis, and valuation fallback
 *   GEMINI_WINE             — used for valuation (primary); skipped if unset
 *
 * Request body:
 *   {
 *     requestType: "label" | "valuation" | "batch-valuation" | "analysis",
 *     prompt?: string,           // required for label / valuation / analysis
 *     image?: { base64, mediaType }, // label only
 *     maxTokens?: number,
 *     enableWebSearch?: boolean, // Claude web search (label/analysis)
 *     bottles?: BottleInfo[],    // batch-valuation only
 *   }
 *
 * Response shape:
 *   label / analysis → raw Anthropic response
 *   valuation        → { text: string, _geminiGrounding?: [...], _fallback?: "claude" }
 *   batch-valuation  → { results: ValuationResult[] }
 */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY_Wine");
const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");

const GEMINI_MODEL = "gemini-2.0-flash";
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

/**
 * Call Gemini with Google Search grounding.
 * On 429 (grounding quota exceeded), immediately retries without grounding —
 * Gemini still has strong wine knowledge from training data and avoids the
 * separate grounding quota entirely. Only throws if both attempts fail.
 */
async function callGemini(prompt: string, maxTokens = 4096): Promise<GeminiResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE secret not set on the server.");

  // Attempt 1: with Google Search grounding
  try {
    const result = await _callGeminiOnce(prompt, maxTokens, true);
    console.log("[wine-ai] Gemini: grounded response OK");
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("429")) throw err; // non-quota error → propagate immediately
    console.warn("[wine-ai] Gemini grounding quota hit (429), retrying without Google Search...");
  }

  // Attempt 2: without grounding (bypasses grounding quota)
  const result = await _callGeminiOnce(prompt, maxTokens, false);
  console.log("[wine-ai] Gemini: ungrounded response OK (grounding quota was exceeded)");
  return result;
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

/** Parse a JSON array of ValuationResult from an AI response text. Returns null on failure. */
function parseBatchText(
  text: string,
  chunk: BottleInfo[],
  chunkIdx: number,
  source: string
): ValuationResult[] | null {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): no JSON array found. Snippet:`, text.slice(0, 200));
    return null;
  }
  try {
    const parsed: ValuationResult[] = JSON.parse(jsonMatch[0]);
    return parsed.map((r, i) => ({ ...r, id: chunk[i]?.id }));
  } catch {
    console.warn(`[wine-ai] Chunk ${chunkIdx} (${source}): JSON parse failed`);
    return null;
  }
}

async function handleBatchValuation(bottles: BottleInfo[]): Promise<Response> {
  if (!bottles || bottles.length === 0) {
    return jsonResponse({ error: "bottles array is empty" }, 400);
  }

  console.log(`[wine-ai] Batch: ${bottles.length} bottle(s) in one request`);

  const prompt = buildBatchPrompt(bottles);
  // Scale token budget with bottle count (~300 tokens per bottle JSON), min 4096, max 16384
  const maxTokens = Math.min(16384, Math.max(4096, bottles.length * 300));

  let geminiError = "";

  // 1. Try Gemini (with retry logic built into callGemini)
  try {
    const { text } = await callGemini(prompt, maxTokens);
    const parsed = parseBatchText(text, bottles, 0, "Gemini");
    if (parsed) {
      console.log(`[wine-ai] Batch: Gemini OK (${parsed.length} results)`);
      return jsonResponse({ results: parsed });
    }
  } catch (err) {
    geminiError = err instanceof Error ? err.message : String(err);
    console.warn(`[wine-ai] Batch: Gemini failed:`, geminiError);
  }

  // 2. Fallback: Claude
  console.log(`[wine-ai] Batch: falling back to Claude`);
  try {
    const { text } = await callClaude(prompt, maxTokens, true);
    const parsed = parseBatchText(text, bottles, 0, "Claude");
    if (parsed) {
      console.log(`[wine-ai] Batch: Claude fallback OK (${parsed.length} results)`);
      return jsonResponse({ results: parsed });
    }
  } catch (err) {
    const claudeMsg = err instanceof Error ? err.message : String(err);
    console.error(`[wine-ai] Batch: Claude fallback also failed:`, claudeMsg);
    return jsonResponse(
      { error: `Gemini failed: ${geminiError}; Claude fallback failed: ${claudeMsg}` },
      502
    );
  }

  return jsonResponse({
    results: bottles.map(b => ({ id: b.id, error: "No valid JSON response from Gemini or Claude" } as ValuationResult)),
  });
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

  // ── Claude-only routes (label + analysis) ────────────────────────────────
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY_Wine is not set on the server." }, 500);
  }

  if (!prompt) {
    return jsonResponse({ error: "prompt is required" }, 400);
  }

  type MessageContent =
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      >;

  let content: MessageContent;

  if (requestType === "label" && image?.base64) {
    content = [
      { type: "image", source: { type: "base64", media_type: image.mediaType || "image/jpeg", data: image.base64 } },
      { type: "text", text: prompt },
    ];
  } else {
    content = prompt;
  }

  try {
    const anthropicHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    };
    if (enableWebSearch) {
      anthropicHeaders["anthropic-beta"] = "web-search-2025-03-05";
    }

    const anthropicBody: Record<string, unknown> = {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };
    if (enableWebSearch) {
      anthropicBody.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(anthropicBody),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => "");
      return jsonResponse(
        { error: `Anthropic API error: ${anthropicRes.status}`, details: errBody.slice(0, 300) },
        anthropicRes.status
      );
    }

    const data = await anthropicRes.json();
    return jsonResponse(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
