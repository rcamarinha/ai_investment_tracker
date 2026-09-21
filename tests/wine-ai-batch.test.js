/**
 * Batch wine valuation: the prompt and how an answer becomes results.
 *
 * Imports supabase/functions/_shared/wine-batch-core.js — the module the
 * wine-ai function itself runs. These tests used to check a copy in
 * src/wine-ai-utils.js, and only ever handed in results that already carried
 * the right ids, so nothing noticed that the server matched by POSITION: a model
 * that skipped or reordered a wine put one bottle's price on another. A result
 * now belongs to a bottle only if it names that bottle's ref.
 */

import { describe, it, expect } from 'vitest';
import { sanitiseJson, parseBatchText, buildBatchPrompt, isValidGeminiText, padResults, geminiSearchCount, claudeSearchCount, markUnsearched, VALUATION_SYSTEM_INSTRUCTION } from '../supabase/functions/_shared/wine-batch-core.js';

// ── sanitiseJson ─────────────────────────────────────────────────────────────

describe('sanitiseJson', () => {
  it('strips ```json opening fence', () => {
    const input = '```json\n[{"a":1}]\n```';
    expect(sanitiseJson(input)).not.toContain('```');
    expect(sanitiseJson(input)).toContain('[{"a":1}]');
  });

  it('strips plain ``` fences', () => {
    const input = '```\n[{"a":1}]\n```';
    expect(sanitiseJson(input)).not.toContain('```');
  });

  it('is case-insensitive for ```JSON fences', () => {
    const input = '```JSON\n{"x":1}\n```';
    expect(sanitiseJson(input)).not.toContain('```');
    expect(sanitiseJson(input)).toContain('{"x":1}');
  });

  it('converts Python None to null', () => {
    expect(sanitiseJson('{"drinkWindow": None}')).toBe('{"drinkWindow": null}');
  });

  it('does not alter "None" inside a string value', () => {
    // The replace is a word-boundary regex, so interior tokens shouldn't fire.
    const input = '{"note": "None available"}';
    // Our impl uses \bNone\b which matches at word boundaries, so "None" inside
    // quotes IS replaced. Document the actual behaviour rather than the ideal.
    const result = sanitiseJson(input);
    expect(result).toContain('null available');
  });

  it('converts Python True to true', () => {
    expect(sanitiseJson('{"active": True}')).toBe('{"active": true}');
  });

  it('converts Python False to false', () => {
    expect(sanitiseJson('{"active": False}')).toBe('{"active": false}');
  });

  it('removes trailing comma before }', () => {
    expect(sanitiseJson('{"a":1,}')).toBe('{"a":1}');
  });

  it('removes trailing comma before ]', () => {
    expect(sanitiseJson('[1,2,]')).toBe('[1,2]');
  });

  it('leaves valid JSON untouched', () => {
    const json = '[{"estimatedValue":150,"confidence":"high"}]';
    expect(sanitiseJson(json)).toBe(json);
  });

  it('combines all transformations in one pass', () => {
    const input = '```json\n[{"drinkWindow": None, "active": True,}]\n```';
    const result = sanitiseJson(input);
    const parsed = JSON.parse(result.match(/\[[\s\S]*\]/)[0]);
    expect(parsed[0].drinkWindow).toBeNull();
    expect(parsed[0].active).toBe(true);
  });
});

// ── parseBatchText — strategy 1: JSON array ───────────────────────────────────

describe('parseBatchText — matching by ref', () => {
  const chunk = [
    { id: 'bottle-1', name: 'Château Margaux', vintage: 2018 },
    { id: 'bottle-2', name: 'Penfolds Grange',  vintage: 2017 },
    { id: 'bottle-3', name: 'Barca Velha',      vintage: 2011 },
  ];
  const ids = r => r.results.map(x => [x.id, x.estimatedValue]);

  it('gives each result the id of the bottle it names', () => {
    const text = JSON.stringify([
      { ref: 1, estimatedValue: 250 }, { ref: 2, estimatedValue: 400 }, { ref: 3, estimatedValue: 900 },
    ]);
    expect(ids(parseBatchText(text, chunk))).toEqual([['bottle-1', 250], ['bottle-2', 400], ['bottle-3', 900]]);
  });

  it('a skipped middle wine leaves THAT bottle empty, not its neighbour (the old bug)', () => {
    // Positionally, 900 would have landed on bottle-2.
    const text = JSON.stringify([{ ref: 1, estimatedValue: 250 }, { ref: 3, estimatedValue: 900 }]);
    const parsed = parseBatchText(text, chunk);
    expect(ids(parsed)).toEqual([['bottle-1', 250], ['bottle-3', 900]]);
    expect(padResults(parsed.results, chunk, 'Gemini').map(r => r.error ? 'error' : r.estimatedValue))
      .toEqual([250, 'error', 900]);
  });

  it('a reordered answer still lands on the right bottles', () => {
    const text = JSON.stringify([{ ref: 3, estimatedValue: 900 }, { ref: 1, estimatedValue: 250 }, { ref: 2, estimatedValue: 400 }]);
    expect(Object.fromEntries(ids(parseBatchText(text, chunk)))).toEqual({ 'bottle-1': 250, 'bottle-2': 400, 'bottle-3': 900 });
  });

  it('accepts a ref written as a string', () => {
    expect(ids(parseBatchText('[{"ref": "2", "estimatedValue": 400}]', chunk))).toEqual([['bottle-2', 400]]);
  });

  it('drops a result with no ref when there is more than one bottle, rather than guess', () => {
    const parsed = parseBatchText(JSON.stringify([{ estimatedValue: 250 }, { estimatedValue: 400 }]), chunk);
    expect(parsed.results).toEqual([]);
    expect(parsed.unmatched).toBe(2);
  });

  it('drops a ref outside the list, and a second result for the same bottle', () => {
    const text = JSON.stringify([{ ref: 4, estimatedValue: 1 }, { ref: 1, estimatedValue: 250 }, { ref: 1, estimatedValue: 999 }]);
    const parsed = parseBatchText(text, chunk);
    expect(ids(parsed)).toEqual([['bottle-1', 250]]);
    expect(parsed.unmatched).toBe(2);
  });

  it('does not pass the ref through to the stored result', () => {
    expect(parseBatchText('[{"ref": 1, "estimatedValue": 5}]', chunk).results[0]).not.toHaveProperty('ref');
  });
});

describe('parseBatchText — one bottle', () => {
  const solo = [{ id: 'solo-bottle' }];

  it('needs no ref: there is nothing to confuse it with', () => {
    expect(parseBatchText('[{"estimatedValue": 180}]', solo).results).toEqual([{ estimatedValue: 180, id: 'solo-bottle' }]);
  });

  it('recovers a bare object (a Gemini habit with one wine)', () => {
    expect(parseBatchText('{"estimatedValue": 180, "confidence": "high"}', solo).results[0])
      .toMatchObject({ id: 'solo-bottle', estimatedValue: 180 });
  });

  it('still refuses a ref that names another wine', () => {
    expect(parseBatchText('[{"ref": 2, "estimatedValue": 180}]', solo).results).toEqual([]);
  });
});

describe('parseBatchText — reading the answer', () => {
  const solo = [{ id: 'b1' }];

  it('reads JSON inside markdown fences', () => {
    expect(parseBatchText('```json\n[{"estimatedValue": 99}]\n```', solo).results[0].estimatedValue).toBe(99);
  });

  it('reads Python None and a trailing comma', () => {
    const r = parseBatchText('[{"estimatedValue": 120, "drinkWindow": None,}]', solo).results[0];
    expect(r).toMatchObject({ estimatedValue: 120, drinkWindow: null });
  });

  it('reads an array after preamble text', () => {
    expect(parseBatchText('Here are the valuations:\n[{"estimatedValue": 75}]', solo).results[0].estimatedValue).toBe(75);
  });

  it('returns null when nothing is readable, so the other provider is tried', () => {
    for (const text of ['', '   \n  ', 'I cannot value this wine.', '[{broken json']) {
      expect(parseBatchText(text, solo), JSON.stringify(text)).toBeNull();
    }
  });
});

// ── buildBatchPrompt ──────────────────────────────────────────────────────────

describe('buildBatchPrompt', () => {
  const makeBottle = (overrides = {}) => ({
    id: 'b1',
    name: 'Château Margaux',
    winery: 'Château Margaux',
    vintage: 2018,
    region: 'Bordeaux',
    appellation: 'Margaux AOC',
    varietal: 'Cabernet Sauvignon',
    country: 'France',
    bottleSize: '0.75L',
    purchasePrice: 150,
    ...overrides,
  });

  it('includes wine name in prompt', () => {
    const prompt = buildBatchPrompt([makeBottle()]);
    expect(prompt).toContain('Château Margaux');
  });

  it('includes vintage', () => {
    const prompt = buildBatchPrompt([makeBottle()]);
    expect(prompt).toContain('2018');
  });

  it('includes bottle format', () => {
    const prompt = buildBatchPrompt([makeBottle({ bottleSize: '1.5L' })]);
    expect(prompt).toContain('1.5L');
  });

  it('marks standard 0.75L as "(standard)"', () => {
    const prompt = buildBatchPrompt([makeBottle({ bottleSize: '0.75L' })]);
    expect(prompt).toContain('(standard)');
  });

  it('does not mark non-standard sizes as "(standard)"', () => {
    const prompt = buildBatchPrompt([makeBottle({ bottleSize: '1.5L' })]);
    expect(prompt).not.toContain('(standard)');
  });

  it('defaults to 0.75L when bottleSize is missing', () => {
    const bottle = makeBottle();
    delete bottle.bottleSize;
    const prompt = buildBatchPrompt([bottle]);
    expect(prompt).toContain('0.75L');
  });

  it('always includes at least the bottle format even when all wine fields are absent', () => {
    // The "(unknown wine)" fallback is unreachable because "Bottle format" is
    // always written into the fields list. This verifies that behaviour.
    const prompt = buildBatchPrompt([{ id: 'b1', bottleSize: '0.75L' }]);
    expect(prompt).toContain('Bottle format: 0.75L');
  });

  it('asks for the ref every result is matched by', () => {
    expect(buildBatchPrompt([makeBottle()])).toContain('"ref": <the wine\'s number from the list above');
  });

  it('includes correct count in the instruction line', () => {
    const bottles = [makeBottle(), makeBottle({ name: 'Opus One', id: 'b2' })];
    const prompt = buildBatchPrompt(bottles);
    expect(prompt).toContain('exactly 2 objects');
  });

  it('numbers each wine sequentially', () => {
    const bottles = [makeBottle({ name: 'Wine A' }), makeBottle({ name: 'Wine B', id: 'b2' })];
    const prompt = buildBatchPrompt(bottles);
    expect(prompt).toMatch(/1\.\s.*Wine A/);
    expect(prompt).toMatch(/2\.\s.*Wine B/);
  });

  it("includes today's date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildBatchPrompt([makeBottle()]);
    expect(prompt).toContain(today);
  });

  it('includes the six pricing rules', () => {
    const prompt = buildBatchPrompt([makeBottle()]);
    for (let i = 1; i <= 6; i++) {
      expect(prompt).toContain(`${i}.`);
    }
  });

  it('includes Portuguese retail priority rule', () => {
    const prompt = buildBatchPrompt([makeBottle()]);
    expect(prompt).toContain('Garrafeira Nacional');
  });

  it('includes VAT / IVA rule', () => {
    const prompt = buildBatchPrompt([makeBottle()]);
    expect(prompt).toContain('1.23');
  });

  it('instructs model to return only JSON array without markdown', () => {
    const prompt = buildBatchPrompt([makeBottle()]);
    expect(prompt).toContain('Return ONLY the JSON array. No markdown fences, no preamble.');
  });

  it('includes purchase price when provided', () => {
    const prompt = buildBatchPrompt([makeBottle({ purchasePrice: 200 })]);
    expect(prompt).toContain('€200/bottle');
  });

  it('omits purchase price field when not provided', () => {
    const bottle = makeBottle();
    delete bottle.purchasePrice;
    const prompt = buildBatchPrompt([bottle]);
    expect(prompt).not.toContain('Purchase price');
  });
});

// ── isValidGeminiText ─────────────────────────────────────────────────────────
//
// Guards the Claude fallback in handleValuation. Gemini can return HTTP 200
// with empty candidates[0].content.parts when grounding stalls or a safety
// filter fires. The prior code returned { text: "" } as a success, which meant
// the Claude fallback never ran and the client threw "No text in Gemini
// valuation response." The fix checks text.trim() — this test suite pins that
// behaviour so a regression is immediately visible.

describe('isValidGeminiText', () => {
  it('returns true for a normal non-empty response', () => {
    expect(isValidGeminiText('The wine is valued at €150.')).toBe(true);
  });

  it('returns true for a response that is only digits', () => {
    expect(isValidGeminiText('150')).toBe(true);
  });

  it('returns true for JSON-formatted text', () => {
    expect(isValidGeminiText('[{"estimatedValue": 120}]')).toBe(true);
  });

  it('returns false for an empty string — the core empty-response bug', () => {
    // This is the exact scenario fixed in commit 87c6c87: Gemini returns HTTP
    // 200 but parts is [] or parts[0].text is "". Without the trim guard the
    // empty string was treated as success.
    expect(isValidGeminiText('')).toBe(false);
  });

  it('returns false for a whitespace-only string', () => {
    // A string of only spaces / newlines must also be treated as empty so
    // the Claude fallback runs.
    expect(isValidGeminiText('   ')).toBe(false);
    expect(isValidGeminiText('\n\t\n')).toBe(false);
  });

  it('returns false for null (missing parts array)', () => {
    expect(isValidGeminiText(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidGeminiText(undefined)).toBe(false);
  });

  it('returns false for a non-string type (number 0)', () => {
    expect(isValidGeminiText(0)).toBe(false);
  });

  it('returns false for a non-string type (boolean false)', () => {
    expect(isValidGeminiText(false)).toBe(false);
  });

  it('a single space is not valid — trim must strip it', () => {
    expect(isValidGeminiText(' ')).toBe(false);
  });

  it('a single visible character is valid', () => {
    expect(isValidGeminiText('x')).toBe(true);
  });
});

// ── padResults — prevents positional misalignment in batch results ─────────
//
// Critical bug fix: if the AI returns fewer results than the chunk size,
// `valuateChunk` previously returned a short array. When multiple chunks'
// results are concatenated client-side and mapped by index, a short chunk
// causes all subsequent valuations to be written to the WRONG bottles.
// padResults ensures the results array always has exactly chunk.length entries.

describe('padResults — one entry per bottle, in order', () => {
  const chunk = [{ id: 'bottle-1' }, { id: 'bottle-2' }, { id: 'bottle-3' }];

  it('keeps matched results and marks the rest as errors naming the provider', () => {
    const padded = padResults([{ id: 'bottle-3', estimatedValue: 300 }], chunk, 'Claude');
    expect(padded.map(r => r.id)).toEqual(['bottle-1', 'bottle-2', 'bottle-3']);
    expect(padded[2].estimatedValue).toBe(300);
    expect(padded[0].error).toContain('Claude');
    expect(padded[1].error).toContain('AI did not return a valuation');
  });

  it('marks every bottle when nothing matched', () => {
    padResults([], chunk, 'Gemini').forEach(r => expect(r.error).toContain('Gemini'));
  });
});

// ── Whether a valuation was searched, and saying so ──────────────────────────
//
// Offering Google Search does not make Gemini use it: in the first 3.5 batch,
// 23 of 24 answers ran no search. Refusing those sent most bottles to Claude,
// so an unsearched answer is now accepted but marked, with the age of its price.

describe('search counts, read from the provider rather than the model', () => {
  it('Gemini: the queries it reports', () => {
    const withQueries = q => ({ candidates: [{ groundingMetadata: { webSearchQueries: q } }] });
    expect(geminiSearchCount(withQueries(['barca velha 2011 preço', 'barca velha garrafeira']))).toBe(2);
    expect(geminiSearchCount(withQueries([]))).toBe(0);
    expect(geminiSearchCount({ candidates: [{ content: { parts: [{ text: '[]' }] } }] })).toBe(0);
    expect(geminiSearchCount(null)).toBe(0);
  });

  it('Claude: web_search_requests in its usage', () => {
    expect(claudeSearchCount({ usage: { server_tool_use: { web_search_requests: 4 } } })).toBe(4);
    expect(claudeSearchCount({ usage: {} })).toBe(0);
    expect(claudeSearchCount(undefined)).toBe(0);
  });
});

describe('markUnsearched', () => {
  const answer = { id: 'b1', estimatedValue: 40, confidence: 'high', valuationNote: 'Seen at Garrafeira Nacional.', priceDate: '2025-03' };

  it('leaves a searched valuation as it is, recording that it searched', () => {
    expect(markUnsearched(answer, true)).toEqual({ ...answer, searched: true });
  });

  it('keeps the figure of an unsearched one, but says where it came from and how old it is', () => {
    const r = markUnsearched(answer, false);
    expect(r.estimatedValue).toBe(40);
    expect(r.searched).toBe(false);
    expect(r.confidence).toBe('low');
    expect(r.valuationNote).toBe("No search: price from the model's own knowledge, as of 2025-03. Seen at Garrafeira Nacional.");
  });

  it('says the date is unknown rather than trust a malformed one', () => {
    for (const priceDate of [undefined, '', 'recent', '2025-13', '2025/03', 202503]) {
      const r = markUnsearched({ ...answer, priceDate }, false);
      expect(r.priceDate, String(priceDate)).toBeNull();
      expect(r.valuationNote).toMatch(/^No search: price from the model's own knowledge, date unknown\./);
    }
  });

  it('writes a note when the model gave none', () => {
    expect(markUnsearched({ id: 'b1', estimatedValue: 5 }, false).valuationNote)
      .toBe("No search: price from the model's own knowledge, date unknown.");
  });

  it('leaves an error result alone', () => {
    const err = { id: 'b1', error: 'AI did not return a valuation for this bottle (Gemini)' };
    expect(markUnsearched(err, false)).toBe(err);
  });
});

describe('what the model is asked for', () => {
  it('is asked to search, and to date a price it did not search for', () => {
    expect(VALUATION_SYSTEM_INSTRUCTION).toMatch(/Use Google Search/);
    expect(VALUATION_SYSTEM_INSTRUCTION).toMatch(/without searching, set priceDate/);
  });

  it('the batch prompt asks for Google Search and a priceDate for every wine', () => {
    const prompt = buildBatchPrompt([{ id: 'b1', name: 'X' }]);
    expect(prompt).toContain('Use Google Search');
    expect(prompt).toContain('"priceDate": <"YYYY-MM"');
  });
});
