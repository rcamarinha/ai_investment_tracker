/**
 * The portfolio AI prompts, built from typed fields — plan P9 step 2.
 *
 * analyze-portfolio used to run whatever prompt the browser sent, on Sonnet,
 * with no time limit, and return Claude's raw reply: any account holder could
 * use it as a general-purpose Claude at the owner's expense. Now the browser
 * sends only data (which perspective, the holdings, the price moves) and the
 * server builds the prompt here, after checking every field.
 *
 * One module for both sides: the edge function imports it, and so does
 * services/analysis.js for the admin's own-key path (the browser calling
 * Anthropic directly), so the two paths cannot drift. Pure, so
 * tests/analysis-prompts.test.js checks it.
 *
 * Display fields (icon, colour, description) stay in data/perspectives.js;
 * a test keeps the names and figures of the two in step.
 */

/** @type {Readonly<Record<string, {name: string, figures: string, prompt: string}>>} */
export const PERSPECTIVES = Object.freeze({
  value: {
    name: "Value Investing",
    figures: "Benjamin Graham, Warren Buffett, Charlie Munger",
    prompt: "You are analyzing this portfolio from the perspective of Classic Value Investing (Deep Intrinsic Value).\n\nCore Philosophy: Buy securities trading below intrinsic value with a margin of safety.\n\nApply these lenses:\n- Graham style: Look for statistical cheapness (low P/B ratios, net-net situations, earnings yield vs bond yields)\n- Buffett/Munger style: Identify high-quality businesses at fair prices with durable competitive advantages (moats)\n- Greenblatt's Magic Formula: Consider earnings yield and return on capital\n- Emphasize margin of safety, circle of competence, and long-term holding periods\n- Flag any positions that seem overvalued relative to intrinsic value estimates\n- Recommend positions that may benefit from a value-oriented approach",
  },
  garp: {
    name: "Growth at Reasonable Price",
    figures: "Peter Lynch",
    prompt: "You are analyzing this portfolio from the perspective of Growth at a Reasonable Price (GARP), as championed by Peter Lynch.\n\nCore Philosophy: \"Buy what you understand.\" Focus on companies growing earnings rapidly but not at absurd valuations.\n\nApply these lenses:\n- PEG ratio thinking: growth rate should justify the P/E multiple\n- Look for \"ten-baggers\" — scalable businesses before Wall Street fully prices them\n- Categorize positions as slow growers, stalwarts, fast growers, cyclicals, turnarounds, or asset plays\n- Identify companies with strong earnings growth that are still reasonably priced\n- Flag positions where growth expectations may already be fully priced in\n- Look for overlooked growth stories the market hasn't recognized yet",
  },
  quant: {
    name: "Quantitative & Systematic",
    figures: "Jim Simons, Cliff Asness",
    prompt: "You are analyzing this portfolio from the perspective of Quantitative & Systematic Investing, as practiced by Jim Simons and Cliff Asness.\n\nCore Philosophy: Use mathematical models, statistical patterns, and factor investing to generate alpha.\n\nApply these lenses:\n- Factor exposure analysis: evaluate portfolio tilt toward value, momentum, size, quality, and low-volatility factors\n- Assess portfolio diversification using correlation thinking — are positions truly independent bets?\n- Identify concentration risks and suggest systematic rebalancing approaches\n- Look for momentum signals (positive and negative) in current holdings\n- Evaluate risk-adjusted returns rather than absolute returns\n- Suggest factor-based portfolio construction improvements\n- Consider mean reversion vs trend-following signals",
  },
  macro: {
    name: "Macro Investing",
    figures: "George Soros, Ray Dalio",
    prompt: "You are analyzing this portfolio from the perspective of Macro Investing (Top-Down), as practiced by George Soros and Ray Dalio.\n\nCore Philosophy: Position for macroeconomic trends — interest rates, currencies, geopolitical shifts, and economic cycles.\n\nApply these lenses:\n- Soros's Reflexivity: How are market participants' beliefs creating self-reinforcing or self-defeating cycles?\n- Dalio's Economic Machine: Where are we in the short-term and long-term debt cycles?\n- All Weather thinking: How would this portfolio perform across different economic environments (growth/inflation rising/falling)?\n- Assess interest rate sensitivity and inflation exposure of each position\n- Evaluate geopolitical risks affecting specific holdings\n- Consider currency exposure and global macro trends\n- Suggest hedging strategies for macro tail risks",
  },
  passive: {
    name: "Index & Passive",
    figures: "John Bogle",
    prompt: "You are analyzing this portfolio from the perspective of Indexing & Passive Investing, as championed by John Bogle.\n\nCore Philosophy: You cannot consistently beat the market — own the market cheaply. Time in market beats timing the market.\n\nApply these lenses:\n- Compare this portfolio's likely performance drag vs a simple total-market index fund\n- Calculate implied costs: trading friction, tax inefficiency, and opportunity cost of concentration\n- Assess how diversified (or concentrated) this portfolio is compared to a broad market index\n- Identify positions that add unnecessary complexity without expected excess return\n- Suggest simplification opportunities — which positions could be replaced by low-cost index exposure?\n- Evaluate the portfolio's tracking error relative to major benchmarks\n- Consider tax-loss harvesting opportunities within a passive framework",
  },
  technical: {
    name: "Technical & Momentum",
    figures: "Jesse Livermore, Paul Tudor Jones",
    prompt: "You are analyzing this portfolio from the perspective of Technical & Momentum Investing, as practiced by Jesse Livermore and Paul Tudor Jones.\n\nCore Philosophy: Price action contains information. Identify and ride trends. Cut losses short and let winners run.\n\nApply these lenses:\n- Assess which positions are likely in uptrends vs downtrends based on recent price action\n- Identify positions that may be breaking out of consolidation patterns\n- Flag positions showing momentum deterioration (potential trend reversals)\n- Apply the \"cut losers, ride winners\" principle — which positions should be trimmed or added to?\n- Consider relative strength — which holdings are outperforming or underperforming the market?\n- Look for potential support/resistance levels and suggest entry/exit timing\n- Evaluate position sizing based on volatility and risk management principles",
  },
});

/** Appended to every prompt so the answer comes back in the page's language. */
export const LANG_INSTRUCTION = Object.freeze({
  en: "",
  pt: "\n\nIMPORTANT: Respond entirely in European Portuguese (português europeu). " +
      "Use formal register (tratamento de \"você\"). " +
      "All section titles, labels, and content must be in Portuguese.",
});

// ── Limits on what the browser may send ─────────────────────────────────────

export const MAX_HOLDINGS = 300;
export const MAX_MOVERS = 6;
// What real symbols use: exchange suffixes (VWRL.L), share classes written with
// a dot, a space or a slash (BRK.B, BRK B, BRK/B), pairs (BTC-EUR, BTC/EUR),
// indices (^GSPC), ISINs, and & or + in some names. Still no line breaks,
// quotes, brackets or other punctuation that could carry an instruction. The
// first version refused a real portfolio outright (21 September).
// One space at most, before a short part (BRK B): symbols need no more, and
// spaces would let a list of "symbols" spell out sentences.
const SYMBOL = /^[A-Za-z0-9^][A-Za-z0-9.=^:_&+/-]{0,23}(?: [A-Za-z0-9.=^:_&+/-]{1,8})?$/;
/** A symbol quoted in a refusal, trimmed and with anything unprintable dropped. */
const shown = v => JSON.stringify(String(v ?? "").replace(/[^\x20-\x7E]/g, "?").slice(0, 40));
const TYPE = /^[A-Za-z][A-Za-z &/-]{0,29}$/;

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const finite = v => typeof v === "number" && Number.isFinite(v);

/**
 * @param {unknown} raw
 * @returns {{ symbol: string, shares: number, avgPrice: number, currentPrice: number|null, type: string }[] | string}
 *   the holdings, or why they were refused
 */
export function checkHoldings(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return "holdings must be a non-empty list";
  if (raw.length > MAX_HOLDINGS) return `at most ${MAX_HOLDINGS} holdings`;
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") return "each holding must be an object";
    const symbol = typeof h.symbol === "string" ? h.symbol.trim() : "";
    if (!SYMBOL.test(symbol)) return `a holding has a symbol the analysis cannot use: ${shown(h.symbol)}`;
    if (!finite(h.shares) || !finite(h.avgPrice) || h.avgPrice < 0) return `holding ${symbol}: shares and avgPrice must be numbers`;
    const current = h.currentPrice === null || h.currentPrice === undefined ? null : h.currentPrice;
    if (current !== null && (!finite(current) || current < 0)) return `holding ${symbol}: currentPrice must be a number`;
    const type = typeof h.type === "string" && TYPE.test(h.type.trim()) ? h.type.trim() : "Stock";
    out.push({ symbol, shares: h.shares, avgPrice: h.avgPrice, currentPrice: current, type });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ symbol: string, changePct: number, prevPrice: number, newPrice: number }[] | string}
 */
export function checkMovers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return "movers must be a non-empty list";
  if (raw.length > MAX_MOVERS) return `at most ${MAX_MOVERS} movers`;
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return "each mover must be an object";
    const symbol = typeof m.symbol === "string" ? m.symbol.trim() : "";
    if (!SYMBOL.test(symbol)) return `a mover has a symbol the analysis cannot use: ${shown(m.symbol)}`;
    if (!finite(m.changePct) || Math.abs(m.changePct) > 10_000) return `mover ${symbol}: changePct must be a number`;
    if (!finite(m.prevPrice) || !finite(m.newPrice) || m.prevPrice <= 0 || m.newPrice <= 0) return `mover ${symbol}: prices must be positive numbers`;
    out.push({ symbol, changePct: m.changePct, prevPrice: m.prevPrice, newPrice: m.newPrice });
  }
  return out;
}

/** @param {Date} [now] */
export function todayLabel(now = new Date()) {
  return now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

// ── The three prompts ────────────────────────────────────────────────────────

/** @param {{ perspective: {name: string, prompt: string}, holdings: ReturnType<typeof checkHoldings> & object[], lang: string }} a */
export function marketsPrompt({ perspective, holdings, lang }) {
  const list = holdings.map(p =>
    `${p.shares} shares of ${p.symbol} at avg price $${p.avgPrice}${p.currentPrice ? ` (current: $${p.currentPrice})` : ""}`).join(", ");
  return `${perspective.prompt}

The portfolio contains: ${list}.

Please provide your analysis in JSON format with these fields:
- marketNews: an OBJECTIVE, perspective-neutral overview of current market conditions and recent notable events affecting equities, bonds, or macro (3-5 sentences). This section should be purely factual — no opinion from any investment philosophy.
- marketOverview: your OPINIONATED assessment of these market conditions strictly through the lens of ${perspective.name}. Explain what a ${perspective.name} practitioner would focus on and how they would interpret current conditions (3-4 sentences). Make it clear this is a ${perspective.name} perspective.
- portfolioImpact: evaluate the specific holdings in this portfolio through the ${perspective.name} lens — which positions align well with this philosophy, which don't, and why (3-4 sentences). Be specific about individual holdings.

Respond ONLY with valid JSON, no markdown, no preamble.${LANG_INSTRUCTION[lang] ?? ""}`;
}

/** @param {{ perspective: {name: string, figures: string, prompt: string}, holdings: object[], lang: string, today: string }} a */
export function tradeIdeasPrompt({ perspective, holdings, lang, today }) {
  const summary = holdings.map(p => {
    const invested = p.shares * p.avgPrice;
    const marketValue = p.currentPrice ? p.shares * p.currentPrice : invested;
    const gainLoss = marketValue - invested;
    const gainLossPct = invested > 0 ? ((gainLoss / invested) * 100).toFixed(1) : 0;
    return `${p.symbol}: ${p.shares} shares @ $${p.avgPrice} avg${p.currentPrice ? `, current $${p.currentPrice} (${gainLoss >= 0 ? "+" : ""}${gainLossPct}%)` : ""}, type: ${p.type || "Stock"}`;
  }).join("\n");

  return `You are a ${perspective.name} investment advisor (inspired by ${perspective.figures}). Today is ${today}.

${perspective.prompt}

The user's current portfolio:
${summary}

Based on current market conditions and this portfolio, provide 3-4 CONCRETE, ACTIONABLE trade ideas for TODAY that align with the ${perspective.name} philosophy.

For each trade idea, provide:
1. A clear action type (REBALANCE, BUY, SELL, TRIM, ADD, or WATCH)
2. Specific ticker symbol(s) involved
3. Current market context (recent price action, news, technical signals relevant to this perspective)
4. The specific action to take (exact percentages, price levels, limit orders)
5. Rationale explaining why this trade fits the ${perspective.name} philosophy

Also provide a brief "Today's Execution Plan" with timing suggestions (Morning, Mid-Day, Afternoon, End of Day).

Respond in JSON format:
{
  "date": "${today}",
  "perspective": "${perspective.name}",
  "marketSummary": "Brief 2-3 sentence overview of today's market conditions",
  "trades": [
    {
      "action": "BUY|SELL|TRIM|ADD|REBALANCE|WATCH",
      "title": "Short descriptive title",
      "subtitle": "One-line trade summary with tickers",
      "tickers": ["TICKER1", "TICKER2"],
      "context": ["bullet point 1 about current conditions", "bullet point 2", "bullet point 3"],
      "specificAction": "Detailed description of exactly what to do",
      "rationale": "Why this fits the ${perspective.name} philosophy"
    }
  ],
  "executionPlan": [
    {"time": "Morning", "action": "What to do in the morning"},
    {"time": "Mid-Day", "action": "What to do mid-day"},
    {"time": "Afternoon", "action": "What to do in the afternoon"}
  ]
}

Respond ONLY with valid JSON, no markdown, no preamble.${LANG_INSTRUCTION[lang] ?? ""}`;
}

/** @param {{ movers: object[], lang: string, today: string }} a */
export function moversPrompt({ movers, lang, today }) {
  const list = movers.map(m => {
    const dir = m.changePct >= 0 ? "up" : "down";
    return `${m.symbol} ${dir} ${Math.abs(m.changePct).toFixed(2)}% (${m.prevPrice.toFixed(2)} → ${m.newPrice.toFixed(2)})`;
  }).join("; ");
  return `Today is ${today}. A portfolio tracker just updated prices and detected these notable moves compared to the previous price snapshot: ${list}.

In 2-3 concise sentences, explain what general market factors, sector news, or company events could plausibly explain these kinds of price moves. Be specific about each ticker if you can, drawing on your knowledge of each company and its sector. Acknowledge if your training data may not cover the latest events, and suggest the investor checks financial news for the latest catalyst.

Reply with plain text only — no markdown, no bullet points, no JSON.${LANG_INSTRUCTION[lang] ?? ""}`;
}

/**
 * Turn a request body into the task to run and its prompt, or a refusal. The
 * only door into analyze-portfolio: nothing in the body becomes prompt text
 * except validated symbols and numbers and an allow-listed perspective.
 *
 * @param {any} body
 * @param {Date} [now]
 * @returns {{ task: string, prompt: string } | { error: string }}
 */
export function buildAnalysisRequest(body, now = new Date()) {
  if (!body || typeof body !== "object") return { error: "request body must be an object" };
  const lang = body.lang === "pt" ? "pt" : "en";
  const today = todayLabel(now);
  const kind = body.task;

  if (kind === "movers") {
    const movers = checkMovers(body.movers);
    if (typeof movers === "string") return { error: movers };
    return { task: "analysis.movers", prompt: moversPrompt({ movers, lang, today }) };
  }

  if (kind === "markets" || kind === "tradeIdeas") {
    const key = typeof body.perspective === "string" ? body.perspective : "";
    if (!own(PERSPECTIVES, key)) return { error: "unknown perspective" };
    const holdings = checkHoldings(body.holdings);
    if (typeof holdings === "string") return { error: holdings };
    const perspective = PERSPECTIVES[key];
    return kind === "markets"
      ? { task: "analysis.markets", prompt: marketsPrompt({ perspective, holdings, lang }) }
      : { task: "analysis.tradeIdeas", prompt: tradeIdeasPrompt({ perspective, holdings, lang, today }) };
  }

  return { error: "task must be markets, tradeIdeas or movers" };
}
