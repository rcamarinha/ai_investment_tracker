// The one way an edge function calls an AI model — plan P9.
//
// runTask(name, { userId, prompt }) looks the task up in ai-tasks.js, calls its
// primary model and, if that fails, its fallback. Every call, whatever the
// task, gets the same rules:
//
//  - a time limit (the task's timeoutMs), after which the call is abandoned;
//  - one usage_events row, including for a timeout or a refused request, so
//    the admin page never shows a fallback as if it were chosen first;
//  - a reply cut off by the output cap, or with no text, counts as a failure;
//  - web search, when a task allows it, is capped (Claude max_uses);
//  - the key goes in a header, never the URL;
//  - one timing log line, and never the provider's error body or the model's
//    output in a log: both can echo statement data or other personal text.
//
// What stays in each function: the prompt (built on the server from typed,
// size-capped fields), input checks, parsing the answer and the response shape.
// The caller's id comes from auth.getUser and is passed in; nothing here holds
// "the current user", because one isolate serves concurrent requests.

import { recordUsage } from "./usage.ts";
import { getTask, type AiTask, type ModelCall } from "./ai-tasks.js";
import {
  anthropicBody, geminiBody, readAnthropic, readGemini, replyFailure, AiError, type ReadReply,
} from "./ai-core.js";

export { AiError };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export interface AiResult extends ReadReply {
  provider: "anthropic" | "gemini";
  model: string;
  ms: number;
  usedFallback: boolean;
}

export interface RunInput {
  userId: string;
  prompt: string;
  system?: string;
}

/**
 * Run a registered task: primary model, then its fallback if the primary fails.
 * Throws AiError with the LAST failure when every model failed.
 */
export async function runTask(taskName: string, input: RunInput): Promise<AiResult> {
  const task = getTask(taskName);
  if (!task) throw new AiError("config", `unknown AI task: ${taskName}`);

  try {
    return await callModel(task, taskName, task.primary, input, false);
  } catch (err) {
    if (!task.fallback) throw err;
    const why = err instanceof AiError ? err.kind : "error";
    console.warn(`[ai] ${taskName}: ${task.primary.provider} failed (${why}), trying ${task.fallback.provider}`);
    return await callModel(task, taskName, task.fallback, input, true);
  }
}

async function callModel(
  task: AiTask,
  taskName: string,
  call: ModelCall,
  input: RunInput,
  usedFallback: boolean,
): Promise<AiResult> {
  const key = Deno.env.get(call.keyEnv) ?? "";
  if (!key) throw new AiError("config", `${call.provider} key not set on the server`);

  const meter = (ok: boolean, response?: unknown) =>
    recordUsage({ userId: input.userId, fn: task.fn, provider: call.provider, model: call.model, ok, response });

  const isClaude = call.provider === "anthropic";
  const url = isClaude ? ANTHROPIC_URL : geminiUrl(call.model);
  const headers: Record<string, string> = isClaude
    ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", "x-goog-api-key": key };
  const body = isClaude
    ? anthropicBody(call, input.prompt, input.system)
    : geminiBody(call, input.prompt, input.system);
  const label = `[ai] ${taskName} ${call.provider} ${call.model}`;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(call.timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    meter(false);
    const name = err instanceof Error ? err.name : "Error";
    console.warn(`${label}: ${name} after ${Date.now() - started}ms`);
    throw name === "TimeoutError"
      ? new AiError("timeout", `no answer within ${Math.round(call.timeoutMs / 1000)}s`)
      : new AiError("network", `could not reach ${call.provider}`);
  }

  if (!res.ok) {
    meter(false);
    // The status only: an error body can repeat the prompt back.
    await res.body?.cancel().catch(() => {});
    console.warn(`${label}: HTTP ${res.status} after ${Date.now() - started}ms`);
    throw new AiError("http", `${call.provider} refused the request (HTTP ${res.status})`, res.status);
  }

  const data = await res.json();
  const reply = isClaude ? readAnthropic(data) : readGemini(data);
  const failure = replyFailure(reply);
  // Tokens were spent either way, so the row carries them; ok says whether the
  // answer could be used.
  meter(!failure, data);
  const ms = Date.now() - started;
  console.log(
    `${label}: ${ms}ms, stop=${reply.stop}, searches=${reply.searches}` +
    (isClaude ? "" : `, thinking=${reply.thinking}/${call.maxTokens}`),
  );
  if (failure) throw failure;

  return { ...reply, provider: call.provider, model: call.model, ms, usedFallback };
}
