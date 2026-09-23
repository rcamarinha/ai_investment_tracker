/**
 * The two spend AI tasks — statement extraction and categorisation — plan P9
 * step 5. The prompts are unchanged from the functions they came from; what is
 * new is that every field is checked before it reaches them, and that reading
 * the answer never logs or echoes it (it is the user's bank data).
 *
 * Pure, so tests/spend-prompts.test.js checks it.
 */

import { readJsonArray } from "./ai-core.js";

export const MAX_STATEMENT_CHARS = 15_000;   // the page chunks to 12K; this is the hard stop
export const MAX_HINT_CHARS = 500;
export const MAX_BATCH = 60;                 // the page batches at 40
export const MAX_CATEGORIES = 150;

/** One line, printable, capped. */
function tidy(v, cap) {
  if (typeof v !== "string") return "";
  return v.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, cap);
}

function statementPrompt(statementText, hint) {
  return `You are a precise bank-statement parser. Extract every completed MONEY MOVEMENT from the statement lines below.

Rules:
- Output ONLY a JSON array. No markdown, no commentary, no preamble.
- Each element: {"date":"YYYY-MM-DD","description":"<what it was>","amount":<signed number>,"currency":"<ISO code>","balance":<running balance or null>,"role":"statement"|"detail"|"skip","group":"<section id, detail rows only>"}
- "amount" is SIGNED: negative when money left the account, positive when it arrived. Never output the absolute value.
- "balance" is the running balance printed on that row, if the statement shows one. Use null when it does not. Do NOT invent it, and never put the balance in "amount".
- Amounts may use European formatting (1.234,56). Convert to a plain number: 1234.56.
- A long description WRAPS onto the next printed line. A line with no date and no
  amount, printed between a movement and the next one, is the REST OF THAT
  MOVEMENT'S DESCRIPTION, not a row of its own: join it to the description with a
  single space and do not output a separate element for it. Keep each description
  COMPLETE and as printed — every name, reference and code — rather than a summary
  or a shortened form. It is what the ledger shows and what categorisation reads.
- Some statements print only day and month. Use the statement period or header to resolve the year. If the year genuinely cannot be determined, omit that row rather than guessing.
- A statement may cover SEVERAL PRODUCTS, not just the current account: a card, a
  mortgage or other loan, a savings account. Only the current account's movements
  are cash leaving or arriving. Everything printed under another product is either
  an itemisation of a movement already listed, or a balance — never a movement of
  its own.
- "role" says what the line IS. This matters more than any other field:
  - "statement" = a movement that changed the ACCOUNT balance. This is the default.
  - "detail"    = a line that ITEMISES another movement instead of being one itself:
                  individual purchases under a credit-card section, MB WAY or wallet
                  breakdowns, and the capital/interest split of a loan instalment.
                  The account did not move separately for these. Their total IS one
                  of the "statement" rows, so counting them as movements would count
                  the same money twice.
  - "skip"      = not a movement at all: an opening or closing balance, an amount
                  outstanding ("saldo devedor", "amount owed"), a credit limit, a
                  product summary, a subtotal, an interest rate, a contracted amount.
                  These are positions, not money moving.
- Decide "role" from STRUCTURE, not wording. A line printed under a card, loan or
  other product heading is "detail" or "skip", never "statement". So is a dated line
  with no running balance while the movements around it each have one.
- A row the statement printed with NO DATE is never "statement". Loan instalment
  breakdowns are printed without one because they share the date of the instalment
  already listed on the account. Do not invent a date for such a row: give it
  "detail" (if it itemises something) or "skip" (if it is a balance), and leave
  "date" null. A movement you had to guess a date for is not a movement you observed.
- Sign "detail" rows from the CARDHOLDER's point of view, not from the way the section
  prints them:
  - a card PURCHASE is money leaving, so NEGATIVE — even where the section prints it
    without a minus because the whole section is understood to be charges;
  - a PAYMENT to the card, a refund or a reversal is money coming back, so POSITIVE —
    even where the section prints it with a minus, which many statements do because a
    minus there means "reduces what you owe".
  A card section often states its own convention in a footnote such as "(-) significa
  pagamentos". Read that as a statement about the printing, and still output the
  cardholder sign. Getting this backwards makes a repayment look like a purchase.
- "group" applies to "detail" rows only, and is null everywhere else. Use whatever
  identifies the section the line was printed under — the card number, the last four
  digits, or the card name as printed. Every line under the same heading MUST get the
  same "group" string, because those lines are summed and reconciled against the
  settlement row they itemise. A statement can carry two cards; mixing their lines
  together would reconcile against the wrong payment.
- Extract every section, but label it. Do not drop the detail lines and do not promote
  them to movements.
- IGNORE: opening/closing balance summaries, subtotals, interest-rate tables, legal or marketing text, page headers and footers, and anything that is not a single dated movement.
- If there are no movements, output [].
${hint ? "\nLayout note for this bank: " + hint + "\n" : ""}
Statement lines:
"""
${statementText}
"""`;
}

function categorisePrompt(transactions, categories) {
  return `You are categorising bank transactions for a personal finance ledger.

Assign each transaction exactly one category from this list, and nothing else:
${categories.map((c) => `- ${c}`).join("\n")}

Rules:
- Output ONLY a JSON array. No markdown, no commentary, no preamble.
- Each element: {"id":"<the id given>","category":"<one of the categories above>","confidence":<0 to 1>}
- Echo the "id" EXACTLY as given. Never invent, reorder or renumber ids.
- Return one element per input transaction. If you cannot tell, still return the element with your best category and a LOW confidence — do not omit it.
- "confidence" is your genuine certainty. Use below 0.5 when the description is opaque (a bare reference number, an unfamiliar acronym). Anything under the caller's threshold goes to a human, so a low score is useful, not a failure.
- Descriptions are Portuguese retail-bank text and are often abbreviated or truncated. Common forms: "COMPRAS C.DEB <merchant>" is a debit-card purchase; "LEVANTAMENTO"/"ATM" is a cash withdrawal; "TRF"/"TRANSF" is a transfer; "PAG SERVICOS" is a bill payment; "COMISSAO"/"IMPOSTO" are bank fees and taxes.
- A negative amount is money leaving the account, a positive amount is money arriving. Never assign a spending category to money arriving.

Transactions:
${JSON.stringify(transactions)}`;
}

/**
 * @param {any} body
 * @returns {{ prompt: string, chars: number } | { error: string, status?: number }}
 */
export function buildStatementRequest(body) {
  const text = typeof body?.statementText === "string" ? body.statementText.trim() : "";
  if (!text) return { error: "statementText is required" };
  if (text.length > MAX_STATEMENT_CHARS) {
    return { error: `statementText exceeds ${MAX_STATEMENT_CHARS} characters - chunk it client-side.`, status: 413 };
  }
  // The layout note was the one field with no limit at all.
  const hint = tidy(body?.hint, MAX_HINT_CHARS);
  return { prompt: statementPrompt(text, hint || undefined), chars: text.length };
}

/**
 * @param {any} body
 * @returns {{ prompt: string, asked: number } | { error: string, status?: number }}
 */
export function buildCategoriseRequest(body) {
  const raw = Array.isArray(body?.transactions) ? body.transactions : [];
  const cats = Array.isArray(body?.categories) ? body.categories : [];
  if (!raw.length) return { error: "transactions is required" };
  if (raw.length > MAX_BATCH) return { error: `Batch of ${raw.length} exceeds ${MAX_BATCH} - split it client-side.`, status: 413 };
  const categories = [...new Set(cats.map((c) => tidy(c, 80)).filter(Boolean))].slice(0, MAX_CATEGORIES);
  if (!categories.length) return { error: "categories is required" };

  const transactions = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return { error: "each transaction must be an object" };
    const id = typeof t.id === "string" || typeof t.id === "number" ? tidy(String(t.id), 64) : "";
    if (!id) return { error: "each transaction needs an id" };
    const amount = typeof t.amount === "number" && Number.isFinite(t.amount) ? t.amount : null;
    transactions.push({
      id,
      description: tidy(t.description, 300),
      amount,
      direction: t.direction === "in" || t.direction === "out" ? t.direction : (amount !== null && amount < 0 ? "out" : "in"),
    });
  }
  return { prompt: categorisePrompt(transactions, categories), asked: transactions.length };
}

/** The JSON array in a model's answer, or null — see ai-core.readJsonArray. */
export const readRows = readJsonArray;
