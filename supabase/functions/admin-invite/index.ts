import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeInviteEmail, summarizeUsers, canRevoke, pickRedirect } from "../_shared/invite-core.js";

// Admin-only invitations.
//
// Public signup is disabled on this project. With signup off, the auth server
// creates users only through invitations, and its invite endpoint requires the
// service role. That key must never reach a browser, so inviting happens here.
//
// POST { action: "list" }                 → { people: [...] }
// POST { action: "invite", email }        → { invited: email }
// POST { action: "revoke", userId }       → { revoked: userId }
//
// Every request is refused unless the caller's token is valid AND their user id
// is in admin_users. The browser page only asks and renders; this function is
// the boundary. The decisions themselves live in ../_shared/invite-core.js so
// the test suite can exercise them.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Two clients, each named for what it is. The publishable key only verifies who
// is calling. The service role key does the admin work and is used for nothing
// else — unlike the other functions here, which load the service role key into
// a variable named for the anon key.
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = [
  "https://cacoventures.com",
  "https://www.cacoventures.com",
  "https://ai-investment-tracker.vercel.app",
];

const NO_SESSION = { persistSession: false, autoRefreshToken: false };

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

type Payload = { action?: string; email?: string; userId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed." });

  // Everything below answers through json(), so every reply carries CORS
  // headers. An escaped exception would reach the browser as a bare "Failed to
  // fetch", indistinguishable from the function not being deployed.
  let action: string | undefined;
  // Once this is true the caller is a verified administrator, so a failure can
  // name its cause. Before it, an error says nothing: the caller is a stranger.
  let callerIsAdmin = false;
  try {
    // ── Who is calling ────────────────────────────────────────────────────────
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json(req, 401, { error: "Sign in first." });

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: NO_SESSION,
    });
    const { data: who, error: whoErr } = await authClient.auth.getUser(token);
    if (whoErr || !who?.user) return json(req, 401, { error: "Your session has expired. Sign in again." });
    const caller = who.user;

    // ── Are they an administrator ─────────────────────────────────────────────
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: NO_SESSION });
    const { data: adminRow, error: adminErr } = await admin
      .from("admin_users").select("user_id").eq("user_id", caller.id).maybeSingle();
    if (adminErr) {
      console.error("[admin-invite] admin check failed:", adminErr.message);
      return json(req, 500, { error: "Could not confirm administrator access." });
    }
    if (!adminRow) return json(req, 403, { error: "Only an administrator can manage invitations." });
    callerIsAdmin = true;

    let body: Payload = {};
    try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid request." }); }
    action = body?.action;

    if (action === "list") {
      // One page of 200 is ample for a household. Past that, this needs paging.
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      return json(req, 200, { people: summarizeUsers(data?.users) });
    }

    if (action === "invite") {
      const parsed = normalizeInviteEmail(body?.email);
      if (!parsed.ok) return json(req, 400, { error: parsed.reason });
      // The landing page is chosen here from the allow-list, never from the body.
      const redirectTo = pickRedirect(req.headers.get("origin") || "", ALLOWED_ORIGINS);
      const { error } = await admin.auth.admin.inviteUserByEmail(parsed.email, redirectTo ? { redirectTo } : {});
      if (error) {
        const msg = String(error.message || "");
        if (/already|registered|exists/i.test(msg)) {
          return json(req, 409, { error: "That address already has an account." });
        }
        // Status first: the wording of auth errors is not a stable contract, and
        // the per-address cooldown ("only request this after N seconds") matches
        // no pattern here but still arrives as 429.
        if ((error as { status?: number }).status === 429 || /rate|too many|only request this after/i.test(msg)) {
          return json(req, 429, {
            error: "Too many emails sent recently. Supabase's built-in email service allows two an hour; try again later, or set up your own SMTP provider.",
          });
        }
        // Delivery, not the invitation, is what usually fails here: Supabase's
        // built-in sender only delivers to members of your own Supabase team.
        // The auth server creates the account and sends the email in one
        // transaction, so a failed send should roll the account back — but the
        // page re-reads the list rather than trusting that, and says to revoke
        // anything left pending.
        if (/sending|smtp|mail/i.test(msg)) {
          return json(req, 502, {
            error: "The invitation email could not be sent. Supabase's built-in sender only delivers to members of your Supabase team — configure your own SMTP provider under Authentication → Emails. If the address shows as pending below, revoke it before inviting again.",
            detail: msg,
          });
        }
        throw error;
      }
      return json(req, 200, { invited: parsed.email });
    }

    if (action === "revoke") {
      const userId = String(body?.userId || "");
      if (!userId) return json(req, 400, { error: "Invalid request." });
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data?.user) return json(req, 404, { error: "That invitation no longer exists." });
      // Revoking deletes the unconfirmed user. canRevoke is what keeps this from
      // ever deleting an account someone is actually using.
      if (!canRevoke(data.user, caller.id)) {
        return json(req, 409, { error: "Only an invitation nobody has accepted can be revoked." });
      }
      const { error: delErr } = await admin.auth.admin.deleteUser(userId);
      if (delErr) throw delErr;
      return json(req, 200, { revoked: userId });
    }

    return json(req, 400, { error: "Unknown action." });
  } catch (err) {
    // Logged server-side with the detail; the caller gets nothing internal.
    const detail = (err as Error)?.message || String(err);
    console.error("[admin-invite]", action, detail);
    // The detail goes no further than an administrator, and without it the page
    // can only say "something went wrong", which is no help to the one person
    // who can act on it.
    return json(req, 500, callerIsAdmin
      ? { error: "Something went wrong. Try again.", detail }
      : { error: "Something went wrong. Try again." });
  }
});
