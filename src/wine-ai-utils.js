/**
 * Pure utility functions for wine-ai edge function batch valuation parsing.
 *
 * Mirrors the logic in supabase/functions/wine-ai/index.ts without any
 * Deno/server dependencies. Imported by the Vitest test suite. Keep in
 * sync with the edge function.
 */

/**
 * Sanitise common AI-response JSON quirks before parsing.
 *
 * - Strips markdown code fences (```json ... ``` or ``` ... ```)
 * - Converts Python-style None → null, True → true, False → false
 * - Removes trailing commas before } or ]
 *
 * @param {string} s Raw text from Gemini or Claude
 * @returns {string} Cleaned string suitable for JSON.parse
 */
export function sanitiseJson(s) {
  return s
    .replace(/```json\s*/gi, '').replace(/```\s*/g, '') // strip markdown fences
    .replace(/\bNone\b/g, 'null')                       // Python-style None
    .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false')
    .replace(/,(\s*[}\]])/g, '$1');                     // trailing commas
}

/**
 * Parse a JSON array of valuation results from an AI response text.
 *
 * Tries two strategies:
 *   1. Extract the first [...] block and parse it as an array.
 *   2. If no array found, try a bare {…} object (Gemini sometimes returns
 *      a single object for single-bottle batches). Wraps it in an array.
 *
 * Returns null if both strategies fail.
 *
 * @param {string} text     Raw AI response text
 * @param {Array}  chunk    Original bottle list for the chunk (used to map ids)
 * @param {number} chunkIdx Chunk index for logging
 * @param {string} source   "Gemini" or "Claude" (for log messages)
 * @returns {Array|null}    Parsed results with id injected, or null on failure
 */
export function parseBatchText(text, chunk, chunkIdx, source) {
  const clean = sanitiseJson(text);

  // Strategy 1: JSON array [...]
  const arrayMatch = clean.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      return parsed.map((r, i) => ({ ...r, id: chunk[i]?.id }));
    } catch {
      // fall through to object strategy
    }
  }

  // Strategy 2: bare object {...} — single-bottle Gemini quirk
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      return [{ ...parsed, id: chunk[0]?.id }];
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Build the batch valuation prompt sent to Gemini / Claude.
 *
 * @param {Array<{
 *   id?: string,
 *   name?: string,
 *   winery?: string,
 *   vintage?: number|string,
 *   region?: string,
 *   appellation?: string,
 *   varietal?: string,
 *   country?: string,
 *   purchasePrice?: number,
 *   notes?: string,
 *   bottleSize?: string,
 * }>} bottles
 * @returns {string} Prompt string
 */
export function buildBatchPrompt(bottles) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = bottles.map((b, i) => {
    const size = b.bottleSize || '0.75L';
    const isStandard = size === '0.75L';
    const fields = [
      b.name        && `Wine name: ${b.name}`,
      b.winery      && `Winery/Producer: ${b.winery}`,
      b.vintage     && `Vintage: ${b.vintage}`,
      b.region      && `Region: ${b.region}`,
      b.appellation && `Appellation: ${b.appellation}`,
      b.varietal    && `Grape variety: ${b.varietal}`,
      b.country     && `Country: ${b.country}`,
      `Bottle format: ${size}${isStandard ? ' (standard)' : ''}`,
      b.purchasePrice && `Purchase price: €${b.purchasePrice}/bottle`,
    ].filter(Boolean).join(', ');
    return `${i + 1}. ${fields || '(unknown wine)'}`;
  }).join('\n');

  return `You are a wine investment expert. Use web search to find current retail and auction market prices for each wine below, then return valuations.

Today's date: ${today}

Wines to value:
${lines}

Return a JSON array with exactly ${bottles.length} objects, one per wine, in the same order. Each object must have:
{
  "estimatedValue": <EUR per bottle in the specified bottle format, number>,
  "estimatedValueUSD": <USD per bottle in the specified bottle format, number>,
  "valueLow": <low end EUR, number>,
  "valueHigh": <high end EUR, number>,
  "drinkWindow": <"YYYY-YYYY" or null>,
  "confidence": <"high"|"medium"|"low">,
  "sources": <brief citation string>,
  "valuationNote": <1-2 sentence explanation>
}

Pricing rules (follow strictly, in priority order):
1. NATIONAL PRIORITY: Search Portuguese retail sites first — Garrafeira Nacional, Garrafeira Soares, Wine.pt, Niepoort shop, JMF shop, Adega Mayor. Only use international sources (Wine-Searcher, Vivino, auction houses) if no Portuguese retailer lists the wine.
2. VAT FILTER: If sourcing from an international ex-tax aggregator (e.g. Wine-Searcher merchant average), multiply by 1.23 to add Portuguese IVA (23%) so the estimate reflects real replacement cost in Portugal.
3. BOTTLE SIZE: Search for the EXACT bottle format listed per wine. Do not extrapolate from 750ml pricing. If no exact-format listing exists, state this in the valuationNote.
4. CURRENT PRICES ONLY: Use in-stock retail or recent auction hammer prices. Skip out-of-stock listings (prices are likely outdated). Never use historical launch/release prices as current value.
5. CROSS-REFERENCE MULTIPLE SOURCES: Always check at least 3 sources. Use the MEDIAN price across found sources as the estimatedValue — do NOT anchor to the single cheapest listing. If one source is 30%+ below all others, it is likely ex-tax, an error, or a different format — exclude it or apply the VAT adjustment.
6. RARE & COLLECTIBLE WINES: For Port, Burgundy, Bordeaux First Growths, and other collectible/investment-grade wines, weight specialist merchants and major auction houses more heavily than generic aggregators.

Additional rules:
- Be vintage-specific (do NOT average across years).
- If you cannot find data for a wine, use low confidence and estimate conservatively.
- Return ONLY the JSON array. No markdown fences, no preamble.`;
}

/**
 * Ensure a parsed results array has exactly chunk.length entries.
 *
 * If the AI returned fewer results than bottles in the chunk, missing bottles
 * are filled with error stubs. If more were returned, the array is truncated.
 * This prevents positional misalignment when multiple chunks are concatenated.
 *
 * @param {Array}  results   Parsed ValuationResult objects from parseBatchText
 * @param {Array}  chunk     Original bottle list for the chunk
 * @param {number} chunkIdx  Chunk index (for logging)
 * @param {string} source    "Gemini" or "Claude"
 * @returns {Array}          Results array with exactly chunk.length entries
 */
export function padResults(results, chunk, chunkIdx, source) {
  if (results.length >= chunk.length) return results.slice(0, chunk.length);
  const padded = [...results];
  const returnedIds = new Set(results.map(r => r.id));
  for (const b of chunk) {
    if (!returnedIds.has(b.id)) {
      padded.push({ id: b.id, error: `AI did not return a valuation for this bottle (${source})` });
    }
  }
  return padded.slice(0, chunk.length);
}

/**
 * Check whether a Gemini (or Claude) text response is meaningful.
 *
 * Gemini occasionally returns HTTP 200 with an empty or whitespace-only text
 * body (grounding stall, safety filter, malformed candidates). The edge function
 * must treat these as failures and fall through to the Claude fallback — which is
 * exactly what the `text.trim()` guard in handleValuation does.
 *
 * This helper centralises that check so the behaviour is explicitly testable.
 *
 * @param {*} text - value from candidates[0].content.parts text join
 * @returns {boolean} true only when the text contains at least one non-whitespace char
 */
export function isValidGeminiText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}
