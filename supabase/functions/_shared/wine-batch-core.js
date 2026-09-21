/**
 * Batch wine valuation: the prompt, and how an answer becomes results.
 *
 * Pure, so the wine-ai function imports it and tests/wine-ai-batch.test.js
 * checks the code that actually runs. It used to be tested through a copy in
 * src/wine-ai-utils.js, and the copy is how a positional-matching bug survived:
 * the server assigned each result the id of the bottle in the same POSITION, so
 * a model that skipped or reordered a wine put one bottle's price on another,
 * while every test handed in results that already carried the right ids.
 *
 * The rule now: a result belongs to a bottle only if it names that bottle's
 * `ref` (its number in the prompt). Position is trusted only when there is one
 * bottle, where there is nothing to confuse it with.
 */

/**
 * Strip the JSON quirks models produce: markdown fences, Python literals,
 * trailing commas.
 * @param {string} s
 * @returns {string}
 */
export function sanitiseJson(s) {
  return String(s ?? "")
    .replace(/```json\s*/gi, "").replace(/```\s*/g, "")
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false")
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * True only for text with at least one non-space character: Gemini can answer
 * HTTP 200 with no text (a stalled search, a safety stop), which is a failure.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isValidGeminiText(text) {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * @param {Array<Record<string, any>>} bottles
 * @param {string} [today] YYYY-MM-DD, for tests
 * @returns {string}
 */
export function buildBatchPrompt(bottles, today = new Date().toISOString().slice(0, 10)) {
  const lines = bottles.map((b, i) => {
    const size = b.bottleSize || "0.75L";
    const isStandard = size === "0.75L";
    const fields = [
      b.name        && `Wine name: ${b.name}`,
      b.winery      && `Winery/Producer: ${b.winery}`,
      b.vintage     && `Vintage: ${b.vintage}`,
      b.region      && `Region: ${b.region}`,
      b.appellation && `Appellation: ${b.appellation}`,
      b.varietal    && `Grape variety: ${b.varietal}`,
      b.country     && `Country: ${b.country}`,
      `Bottle format: ${size}${isStandard ? " (standard)" : ""}`,
      b.purchasePrice && `Purchase price: €${b.purchasePrice}/bottle`,
    ].filter(Boolean).join(", ");
    return `${i + 1}. ${fields || "(unknown wine)"}`;
  }).join("\n");

  return `You are a wine investment expert. Use web search to find current retail and auction market prices for each wine below, then return valuations.

Today's date: ${today}

Wines to value:
${lines}

Return a JSON array with exactly ${bottles.length} objects, one per wine. Each object must have:
{
  "ref": <the wine's number from the list above, e.g. 1>,
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

/** @param {string} clean @returns {Array<Record<string, any>> | null} */
function parseAnswer(clean) {
  const arrayMatch = clean.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed.filter(r => r && typeof r === "object");
    } catch { /* try the object form */ }
  }
  // Gemini sometimes returns a bare object for a one-wine batch.
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return [parsed];
    } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Turn a model's answer into results carrying the id of the bottle each one is
 * about. Returns null when nothing could be read at all (so the caller can try
 * the other provider), otherwise only the results that could be PROVEN to
 * belong to a bottle — a result with a missing, unknown or repeated ref is
 * dropped, never guessed. padResults turns the gaps into explicit errors.
 *
 * @param {string} text
 * @param {Array<{id?: string}>} chunk
 * @returns {{ results: Array<Record<string, any>>, unmatched: number } | null}
 */
export function parseBatchText(text, chunk) {
  const parsed = parseAnswer(sanitiseJson(text));
  if (!parsed) return null;

  const results = [];
  const used = new Set();
  let unmatched = 0;
  for (const r of parsed) {
    const ref = Number(r.ref);
    let idx = Number.isInteger(ref) && ref >= 1 && ref <= chunk.length ? ref - 1 : -1;
    // One bottle: there is nothing to confuse it with, so a missing ref is fine.
    // A ref that names a wine not in the list is still refused.
    if (idx === -1 && chunk.length === 1 && (r.ref === undefined || r.ref === null)) idx = 0;
    if (idx === -1 || used.has(idx)) { unmatched++; continue; }
    used.add(idx);
    const { ref: _ref, ...rest } = r;
    results.push({ ...rest, id: chunk[idx]?.id });
  }
  return { results, unmatched };
}

/**
 * One entry per bottle, in chunk order: its result, or an explicit error saying
 * the model returned nothing that could be matched to it.
 * @param {Array<Record<string, any>>} results
 * @param {Array<{id?: string}>} chunk
 * @param {string} source
 * @returns {Array<Record<string, any>>}
 */
export function padResults(results, chunk, source) {
  const byId = new Map(results.map(r => [r.id, r]));
  return chunk.map(b => byId.get(b.id)
    ?? { id: b.id, error: `AI did not return a valuation for this bottle (${source})` });
}
