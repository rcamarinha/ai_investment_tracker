/**
 * Supabase Edge Function — Wine AI
 *
 * Routes AI requests for the Wine Cellar Tracker:
 *
 *   label       → Claude (vision + text) for label recognition
 *   valuation   → Gemini 1.5 Pro with Google Search grounding for single-bottle pricing
 *   batch-valuation → Gemini 1.5 Pro, bottles chunked 8 at a time in parallel
 *   analysis    → Claude for cellar insights
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY_Wine  — used for label + analysis requests
 *   GEMINI_WINE             — used for valuation requests (single + batch)
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
 *   valuation        → { text: string, _geminiGrounding?: [...] }
 *   batch-valuation  → { results: ValuationResult[] }
 */

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY_Wine");
const GEMINI_API_KEY    = Deno.env.get("GEMINI_WINE");

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const BATCH_CHUNK_SIZE = 8; // bottles per Gemini request in batch mode

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

// ── Gemini helpers ────────────────────────────────────────────────────────────

interface GeminiResult {
  text: string;
  groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
}

/**
 * Call Gemini 1.5 Pro with optional Google Search grounding.
 * Returns { text, groundingChunks }.
 */
async function callGemini(prompt: string, maxTokens = 4096): Promise<GeminiResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_WINE secret not set on the server.");

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: maxTokens },
  };

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

  return { text, groundingChunks };
}

// ── Single-bottle valuation via Gemini ────────────────────────────────────────

async function handleGeminiValuation(prompt: string): Promise<Response> {
  try {
    const { text, groundingChunks } = await callGemini(prompt, 4096);
    return jsonResponse({ text, _geminiGrounding: groundingChunks ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wine-ai] Gemini valuation error:", message);
    return jsonResponse({ error: message }, 502);
  }
}

// ── Batch valuation via Gemini ────────────────────────────────────────────────

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

/**
 * Build a prompt that asks Gemini to value multiple bottles at once.
 * Returns a JSON array of ValuationResult objects in the same order.
 */
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

  return `You are a wine investment expert. Use Google Search to find current retail and auction market prices for each wine below, then return valuations.

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

/**
 * Process an array of bottles in parallel chunks via Gemini.
 * Returns a flat array of ValuationResult matching the input order.
 */
async function handleGeminiBatchValuation(bottles: BottleInfo[]): Promise<Response> {
  if (!bottles || bottles.length === 0) {
    return jsonResponse({ error: "bottles array is empty" }, 400);
  }

  // Split into chunks
  const chunks: BottleInfo[][] = [];
  for (let i = 0; i < bottles.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(bottles.slice(i, i + BATCH_CHUNK_SIZE));
  }

  console.log(`[wine-ai] Batch: ${bottles.length} bottle(s) → ${chunks.length} Gemini chunk(s)`);

  // Run all chunks in parallel
  const chunkPromises = chunks.map(async (chunk, chunkIdx) => {
    const prompt = buildBatchPrompt(chunk);
    try {
      const { text } = await callGemini(prompt, 4096);

      // Parse JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn(`[wine-ai] Chunk ${chunkIdx}: no JSON array in response. text snippet:`, text.slice(0, 200));
        return chunk.map(b => ({ id: b.id, error: "Could not parse Gemini response" } as ValuationResult));
      }

      let parsed: ValuationResult[];
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return chunk.map(b => ({ id: b.id, error: "Invalid JSON from Gemini" } as ValuationResult));
      }

      // Attach original IDs
      return parsed.map((r, i) => ({ ...r, id: chunk[i]?.id }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wine-ai] Chunk ${chunkIdx} failed:`, msg);
      return chunk.map(b => ({ id: b.id, error: msg } as ValuationResult));
    }
  });

  const chunkResults = await Promise.all(chunkPromises);
  const results: ValuationResult[] = chunkResults.flat();

  console.log(`[wine-ai] Batch complete: ${results.filter(r => !r.error).length}/${results.length} succeeded`);
  return jsonResponse({ results });
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Parse body
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

  // ── Gemini routes (valuation + batch-valuation) ──────────────────────────
  if (requestType === "valuation") {
    if (!prompt) return jsonResponse({ error: "prompt is required for valuation" }, 400);
    return handleGeminiValuation(prompt);
  }

  if (requestType === "batch-valuation") {
    if (!Array.isArray(bottles) || bottles.length === 0) {
      return jsonResponse({ error: "bottles array is required for batch-valuation" }, 400);
    }
    return handleGeminiBatchValuation(bottles);
  }

  // ── Claude routes (label + analysis) ────────────────────────────────────
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
      model: "claude-opus-4-6",
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
