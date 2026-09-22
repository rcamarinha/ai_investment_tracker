// Whether a model trial runs for this request — plan P9 step 5b.
//
// A trial doubles the AI calls it covers, so it is switched on only when BOTH
// hold, each checked on the server:
//   1. the secret AI_SHADOW lists the task (comma-separated task names), and
//   2. the verified caller is in admin_users.
// Never a field the page sends: signup is by invitation, account holders are
// untrusted, and a request field would let any of them double the spend on the
// shared key with nothing to stop it. The secret is read on every request, so
// removing it ends the trial without a redeploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function shadowEnabled(taskName: string, userId: string): Promise<boolean> {
  const listed = (Deno.env.get("AI_SHADOW") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!listed.includes(taskName) || !userId) return false;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return false;
  try {
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.from("admin_users").select("user_id").eq("user_id", userId).maybeSingle();
    return !error && !!data;
  } catch {
    return false;   // fail closed: no trial rather than a trial for the wrong person
  }
}
