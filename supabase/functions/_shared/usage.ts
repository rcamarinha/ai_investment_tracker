import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildUsageRow } from "./usage-core.js";

// Records one usage_events row per upstream call (plan P5: count, do not
// enforce). Call it after every model or quote request, success or failure:
//
//   recordUsage({ userId, fn: "wine-ai", provider: "anthropic", model, ok: true, response: json });
//
// Two properties every caller relies on:
//
// 1. It NEVER throws and never delays the user's response. Recording what a
//    request cost must not be able to break that request. Failures are logged
//    to the function's own logs and nothing else.
//
// 2. It writes with its OWN service-role client. Every function here already
//    has a client, but each one sends the caller's token as its Authorization
//    header, so its database writes run as that user — and usage_events refuses
//    every write from a user, which is the point of the table. Writing through
//    the existing client would fail silently on every call.

// Untyped schema on purpose: this client touches one table, and its row shape
// is built and tested in usage-core.js.
let writer: SupabaseClient | null = null;

function getWriter() {
  if (writer) return writer;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  writer = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return writer;
}

export type UsageEvent = {
  userId: string;
  fn: string;
  provider: string;
  model?: string | null;
  ok?: boolean;
  response?: unknown;
  units?: number;
};

export function recordUsage(event: UsageEvent): Promise<void> {
  const task = (async () => {
    try {
      const row = buildUsageRow(event);
      if (!row) {
        console.warn("[usage] not recorded: event could not be attributed", event?.fn);
        return;
      }
      const w = getWriter();
      if (!w) {
        console.warn("[usage] not recorded: no service role key");
        return;
      }
      const { error } = await w.from("usage_events").insert(row);
      if (error) console.error("[usage] not recorded:", error.message);
    } catch (err) {
      console.error("[usage] not recorded:", (err as Error)?.message || err);
    }
  })();
  // Let the write finish after the response has gone, without holding it up.
  // Outside Supabase's runtime the promise simply runs on its own.
  try {
    (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(task);
  } catch { /* ignore */ }
  return task;
}
