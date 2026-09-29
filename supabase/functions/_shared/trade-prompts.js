/**
 * extract-trades: the prompt and what may reach it — plan P9 step 6.
 *
 * The page sends a chunk of a broker statement (a Revolut PDF's text, a
 * BancoBest confirmation) and gets back trades for the ledger. Unlike a bank
 * statement there is NO balance to check the answer against, so the page
 * refuses the whole import when any chunk comes back unreadable — which makes
 * "unreadable" a distinction this module must preserve rather than smooth over.
 *
 * Pure, so tests/trade-prompts.test.js checks it.
 */

import { readJsonArray } from "./ai-core.js";

/** The page chunks to 12K; this is the hard stop. */
export const MAX_TEXT_CHARS = 15_000;

/** The trades in a model's answer, or null when it could not be read. */
export const readTrades = readJsonArray;

/**
 * @param {any} body
 * @returns {{ prompt: string, chars: number } | { error: string }}
 */
export function buildTradeRequest(body) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return { error: "Statement text is required" };
  if (text.length > MAX_TEXT_CHARS) {
    return { error: `Text too long (max ${MAX_TEXT_CHARS} chars). Split it into smaller parts.` };
  }

  const prompt = `You are a precise financial statement parser. Extract every EXECUTED buy or sell securities trade from the statement text below.

Rules:
- Output ONLY a JSON array. No markdown, no commentary, no preamble.
- Each element: {"date":"YYYY-MM-DD","identifier":"<ticker or ISIN>","side":"buy"|"sell","shares":<number>,"price":<number per share>,"fees":<number>,"currency":"<ISO code>"}.
- "identifier" is the ticker symbol if present, otherwise the ISIN.
- "price" is the price PER SHARE in the trade's native currency (compute from total/quantity if only a total is shown).
- "shares" is always a positive number; use "side" to indicate direction.
- IGNORE dividends, interest, deposits, withdrawals, top-ups, currency exchanges, fee-only rows, and stock splits.
- If no trades are present, output [].

Statement text:
"""
${text}
"""`;

  return { prompt, chars: text.length };
}
