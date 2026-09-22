/**
 * The provider-shaped half of every AI call — plan P9. Pure, so
 * tests/ai-core.test.js checks exactly what _shared/ai.ts sends and how it
 * reads a reply. ai.ts adds only what needs the network: the time limit, the
 * usage record and the timing log.
 *
 * The rules a reply is read by are the same for every task:
 *  - a reply cut off by the output cap is a FAILURE, not a short answer
 *    (a truncated JSON array parses as nothing, or worse, as part of itself);
 *  - a reply with no text is a failure;
 *  - how many web searches ran is read from the provider's own record, never
 *    from the model's text.
 */

/**
 * @param {import("./ai-tasks.js").ModelCall} call
 * @param {string} prompt
 * @param {string} [system]
 */
export function anthropicBody(call, prompt, system) {
  /** @type {Record<string, unknown>} */
  const body = {
    model: call.model,
    max_tokens: call.maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;
  if (call.searches && call.searches > 0) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: call.searches }];
  }
  return body;
}

/**
 * @param {import("./ai-tasks.js").ModelCall} call
 * @param {string} prompt
 * @param {string} [system]
 */
export function geminiBody(call, prompt, system) {
  /** @type {Record<string, unknown>} */
  const generationConfig = { maxOutputTokens: call.maxTokens };
  // Thinking counts against maxOutputTokens and is most of a call's time, so it
  // is always set explicitly. "off" is the 2.5 budget form; "low" is the 3.x
  // level form (measured on wine-ai: 38s -> 10-16s).
  if (call.thinking === "off") generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (call.thinking === "low") generationConfig.thinkingConfig = { thinkingLevel: "low" };
  /** @type {Record<string, unknown>} */
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // Gemini decides for itself whether to search; the tool only allows it.
  if (call.searches && call.searches > 0) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * @typedef {object} ReadReply
 * @property {string} text
 * @property {string} stop        the provider's own stop / finish reason
 * @property {boolean} truncated  cut off by the output cap
 * @property {number} searches    web searches the provider reports it ran
 * @property {number} thinking    thinking tokens (Gemini), else 0
 */

/** @param {any} data @returns {ReadReply} */
export function readAnthropic(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(b => b?.type === "text").map(b => b.text ?? "").join("");
  const stop = String(data?.stop_reason ?? "none");
  const n = Number(data?.usage?.server_tool_use?.web_search_requests);
  return {
    text,
    stop,
    truncated: stop === "max_tokens",
    searches: Number.isFinite(n) && n > 0 ? n : 0,
    thinking: 0,
  };
}

/** @param {any} data @returns {ReadReply} */
export function readGemini(data) {
  const cand = data?.candidates?.[0];
  const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  // Thought summaries are parts flagged `thought`; they are not the answer.
  const text = parts.filter(p => !p?.thought).map(p => p?.text ?? "").join("");
  const stop = String(cand?.finishReason ?? "none");
  const queries = cand?.groundingMetadata?.webSearchQueries;
  const thinking = Number(data?.usageMetadata?.thoughtsTokenCount);
  return {
    text,
    stop,
    truncated: stop === "MAX_TOKENS",
    searches: Array.isArray(queries) ? queries.length : 0,
    thinking: Number.isFinite(thinking) ? thinking : 0,
  };
}

/**
 * Why a call failed, in words safe to log and to show: never the provider's
 * error body, which can echo the prompt (statement data) or carry a key.
 */
export class AiError extends Error {
  /**
   * @param {"config"|"timeout"|"network"|"http"|"truncated"|"empty"|"unusable"} kind
   * @param {string} message
   * @param {number} [status]
   */
  constructor(kind, message, status) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The failure a reply represents, or null when it is usable.
 * @param {ReadReply} reply
 * @returns {AiError|null}
 */
export function replyFailure(reply) {
  if (reply.truncated) return new AiError("truncated", `answer cut off by the output cap (${reply.stop})`);
  if (!reply.text.trim()) return new AiError("empty", `no text in the answer (${reply.stop})`);
  return null;
}
