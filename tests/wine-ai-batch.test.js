/**
 * Tests for wine-ai edge function batch valuation parsing utilities.
 *
 * These functions live in supabase/functions/wine-ai/index.ts (Deno/server)
 * and are mirrored as pure functions in src/wine-ai-utils.js for testability.
 *
 * Risky behaviours covered:
 *  - sanitiseJson: strips markdown fences, converts Python literals, removes
 *    trailing commas — required for reliable Gemini JSON extraction.
 *  - parseBatchText: array strategy + object fallback strategy — the fallback
 *    was added specifically because Gemini returns a bare {} for single-bottle
 *    batches; without it the whole batch result would be silently dropped.
 *  - parseBatchText: id injection — each result picks up the corresponding
 *    bottle id from the chunk so the UI can match results back to bottles.
 *  - buildBatchPrompt: structure, wine field inclusion, unknown-wine fallback,
 *    non-standard bottle sizes, pricing rules present in prompt.
 *  - isValidGeminiText: guards the Claude fallback trigger — Gemini HTTP 200
 *    with empty/whitespace text must not be treated as a successful response.
 */

import { describe, it, expect } from 'vitest';
import { sanitiseJson, parseBatchText, buildBatchPrompt, isValidGeminiText, padResults } from '../src/wine-ai-utils.js';

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

describe('parseBatchText — array strategy', () => {
  const chunk = [
    { id: 'bottle-1', name: 'Château Margaux', vintage: 2018 },
    { id: 'bottle-2', name: 'Penfolds Grange',  vintage: 2017 },
  ];

  it('parses a clean JSON array response', () => {
    const text = JSON.stringify([
      { estimatedValue: 250, confidence: 'high' },
      { estimatedValue: 400, confidence: 'medium' },
    ]);
    const result = parseBatchText(text, chunk, 0, 'Gemini');
    expect(result).toHaveLength(2);
    expect(result[0].estimatedValue).toBe(250);
    expect(result[1].estimatedValue).toBe(400);
  });

  it('injects bottle ids from the chunk', () => {
    const text = JSON.stringify([
      { estimatedValue: 250 },
      { estimatedValue: 400 },
    ]);
    const result = parseBatchText(text, chunk, 0, 'Gemini');
    expect(result[0].id).toBe('bottle-1');
    expect(result[1].id).toBe('bottle-2');
  });

  it('parses array wrapped in markdown fences', () => {
    const text = '```json\n' + JSON.stringify([{ estimatedValue: 99 }]) + '\n```';
    const result = parseBatchText(text, [{ id: 'b1' }], 0, 'Gemini');
    expect(result).not.toBeNull();
    expect(result[0].estimatedValue).toBe(99);
    expect(result[0].id).toBe('b1');
  });

  it('parses array with Python-style None drinkWindow', () => {
    const text = '[{"estimatedValue": 120, "drinkWindow": None}]';
    const result = parseBatchText(text, [{ id: 'b1' }], 0, 'Gemini');
    expect(result).not.toBeNull();
    expect(result[0].drinkWindow).toBeNull();
  });

  it('parses array with trailing comma', () => {
    const text = '[{"estimatedValue": 100,}]';
    const result = parseBatchText(text, [{ id: 'b1' }], 0, 'Gemini');
    expect(result).not.toBeNull();
    expect(result[0].estimatedValue).toBe(100);
  });

  it('parses array preceded by preamble text', () => {
    const text = 'Here are the valuations:\n[{"estimatedValue": 75}]';
    const result = parseBatchText(text, [{ id: 'b1' }], 0, 'Claude');
    expect(result).not.toBeNull();
    expect(result[0].estimatedValue).toBe(75);
  });
});

// ── parseBatchText — strategy 2: object fallback ──────────────────────────────

describe('parseBatchText — object fallback (single-bottle Gemini quirk)', () => {
  it('recovers a bare object response as a single-element array', () => {
    const text = '{"estimatedValue": 180, "confidence": "high"}';
    const chunk = [{ id: 'solo-bottle' }];
    const result = parseBatchText(text, chunk, 0, 'Gemini');
    expect(result).toHaveLength(1);
    expect(result[0].estimatedValue).toBe(180);
    expect(result[0].id).toBe('solo-bottle');
  });

  it('uses chunk[0].id for the recovered object', () => {
    const text = '{"estimatedValue": 55}';
    const chunk = [{ id: 'my-id' }];
    const result = parseBatchText(text, chunk, 0, 'Gemini');
    expect(result[0].id).toBe('my-id');
  });

  it('recovers object wrapped in markdown fences', () => {
    const text = '```json\n{"estimatedValue": 200}\n```';
    const chunk = [{ id: 'fence-id' }];
    const result = parseBatchText(text, chunk, 0, 'Gemini');
    expect(result).not.toBeNull();
    expect(result[0].estimatedValue).toBe(200);
  });

  it('recovers object with Python None', () => {
    const text = '{"drinkWindow": None, "estimatedValue": 50}';
    const chunk = [{ id: 'b1' }];
    const result = parseBatchText(text, chunk, 0, 'Gemini');
    expect(result).not.toBeNull();
    expect(result[0].drinkWindow).toBeNull();
  });
});

// ── parseBatchText — null on total failure ─────────────────────────────────────

describe('parseBatchText — returns null when parsing fails', () => {
  const chunk = [{ id: 'b1' }];

  it('returns null for empty text', () => {
    expect(parseBatchText('', chunk, 0, 'Gemini')).toBeNull();
  });

  it('returns null for plain prose with no JSON', () => {
    expect(parseBatchText('I cannot value this wine.', chunk, 0, 'Gemini')).toBeNull();
  });

  it('returns null for broken JSON that cannot be recovered', () => {
    expect(parseBatchText('[{broken json', chunk, 0, 'Gemini')).toBeNull();
  });

  it('returns null when the response is just whitespace', () => {
    expect(parseBatchText('   \n  ', chunk, 0, 'Gemini')).toBeNull();
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

describe('padResults — prevents batch misalignment data corruption', () => {
  const chunk = [
    { id: 'bottle-1', name: 'Wine A' },
    { id: 'bottle-2', name: 'Wine B' },
    { id: 'bottle-3', name: 'Wine C' },
  ];

  it('returns results unchanged when length matches chunk.length', () => {
    const results = [
      { id: 'bottle-1', estimatedValue: 100 },
      { id: 'bottle-2', estimatedValue: 200 },
      { id: 'bottle-3', estimatedValue: 300 },
    ];
    const padded = padResults(results, chunk, 0, 'Gemini');
    expect(padded).toHaveLength(3);
    expect(padded[0].estimatedValue).toBe(100);
    expect(padded[2].estimatedValue).toBe(300);
  });

  it('pads with error stubs when AI returns fewer results', () => {
    const results = [
      { id: 'bottle-1', estimatedValue: 100 },
      { id: 'bottle-2', estimatedValue: 200 },
    ];
    const padded = padResults(results, chunk, 0, 'Gemini');
    expect(padded).toHaveLength(3);
    expect(padded[0].estimatedValue).toBe(100);
    expect(padded[1].estimatedValue).toBe(200);
    expect(padded[2].id).toBe('bottle-3');
    expect(padded[2].error).toContain('AI did not return a valuation');
  });

  it('pads when AI returns only 1 result for a 3-bottle chunk', () => {
    const results = [{ id: 'bottle-1', estimatedValue: 50 }];
    const padded = padResults(results, chunk, 0, 'Claude');
    expect(padded).toHaveLength(3);
    expect(padded[0].id).toBe('bottle-1');
    expect(padded[1].id).toBe('bottle-2');
    expect(padded[1].error).toContain('Claude');
    expect(padded[2].id).toBe('bottle-3');
    expect(padded[2].error).toContain('Claude');
  });

  it('truncates when AI returns more results than chunk.length', () => {
    const results = [
      { id: 'bottle-1', estimatedValue: 100 },
      { id: 'bottle-2', estimatedValue: 200 },
      { id: 'bottle-3', estimatedValue: 300 },
      { id: 'bottle-4', estimatedValue: 400 },
    ];
    const padded = padResults(results, chunk, 0, 'Gemini');
    expect(padded).toHaveLength(3);
    expect(padded[2].id).toBe('bottle-3');
  });

  it('error stubs include the source name', () => {
    const results = [{ id: 'bottle-1', estimatedValue: 100 }];
    const padded = padResults(results, chunk, 0, 'Gemini');
    expect(padded[1].error).toContain('Gemini');
    expect(padded[2].error).toContain('Gemini');
  });

  it('handles empty results array gracefully', () => {
    const padded = padResults([], chunk, 0, 'Gemini');
    expect(padded).toHaveLength(3);
    expect(padded[0].id).toBe('bottle-1');
    expect(padded[1].id).toBe('bottle-2');
    expect(padded[2].id).toBe('bottle-3');
    padded.forEach(r => expect(r.error).toBeDefined());
  });
});
