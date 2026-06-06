// =====================================================================
// CEGIS — Edge Function — generate-credentials (Phase 6)
//
// Turns imported participants (participants.user_id IS NULL) into real
// accounts. Runs with the Supabase SERVICE-ROLE key, which BYPASSES RLS —
// so this code is a trust boundary and MUST re-check tenant membership
// itself (per the security model, §4 of the build prompt):
//
//   1. Identify the caller from their forwarded JWT (auth.getUser()).
//   2. Read the caller's role + org_id AUTHORITATIVELY from the DB
//      (profiles), never from client-supplied claims.
//   3. Confirm caller is an admin, and that the target cohort + every
//      target participant row belongs to the caller's org.
//   4. For each participant: create an auth user (random password) OR
//      send a magic-link invite, create the participant's profiles row
//      (role='participant') so the access-token hook can stamp claims,
//      and link participants.user_id.
//   5. Write ONE audit_log entry. Never persist a plaintext password —
//      generated passwords are returned to the admin once, in the
//      response body, for manual distribution.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically into every Edge Function — no `secrets set`
// step is required for this function.
//
// Deploy:  supabase functions deploy generate-credentials
// (Keep gateway JWT verification ON — do NOT pass --no-verify-jwt.)
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Crypto-random password, no ambiguous characters (no 0/O/1/l/I), so it
// stays legible when an admin distributes it by hand.
function genPassword(len = 16): string {
  const charset =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += charset[bytes[i] % charset.length];
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "missing Authorization header" }, 401);

    // --- 1. identify the caller from their own JWT ---
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) return json({ error: "invalid or expired token" }, 401);

    // --- privileged client (bypasses RLS) ---
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // --- 2. authoritative role + org from the DB, not from claims ---
    const { data: prof, error: pErr } = await admin
      .from("profiles")
      .select("org_id, role")
      .eq("id", user.id)
      .single();
    if (pErr || !prof) return json({ error: "caller has no profile" }, 403);
    if (prof.role !== "admin") {
      return json({ error: "only an org admin may generate credentials" }, 403);
    }
    const callerOrg = prof.org_id as string;

    // --- parse request ---
    const body = await req.json().catch(() => ({}));
    const cohortId: string | undefined = body.cohort_id;
    const mode: "invite" | "password" =
      body.mode === "password" ? "password" : "invite";
    const redirectTo: string | undefined = body.redirect_to || undefined;
    if (!cohortId) return json({ error: "cohort_id is required" }, 400);

    // --- 3. confirm the cohort belongs to the caller's org ---
    const { data: cohort, error: cErr } = await admin
      .from("cohorts")
      .select("id, org_id, name")
      .eq("id", cohortId)
      .is("deleted_at", null)
      .single();
    if (cErr || !cohort) return json({ error: "cohort not found" }, 404);
    if (cohort.org_id !== callerOrg) {
      return json({ error: "cohort belongs to a different organization" }, 403);
    }

    // target = this cohort, this org, not yet linked to an account
    const { data: targets, error: tErr } = await admin
      .from("participants")
      .select("id, org_id, name, email, user_id")
      .eq("cohort_id", cohortId)
      .is("deleted_at", null)
      .is("user_id", null);
    if (tErr) return json({ error: tErr.message }, 500);

    const results: Array<Record<string, unknown>> = [];
    let created = 0, invited = 0, skipped = 0, failed = 0;

    for (const p of targets ?? []) {
      // defensive per-row org re-check (belt and braces over the query filter)
      if (p.org_id !== callerOrg) {
        skipped++;
        results.push({ participant_id: p.id, name: p.name, status: "skipped", reason: "org mismatch" });
        continue;
      }
      const email = String(p.email ?? "").trim().toLowerCase();
      if (!email) {
        skipped++;
        results.push({ participant_id: p.id, name: p.name, status: "skipped", reason: "no email" });
        continue;
      }

      let newId: string | undefined;
      try {
        if (mode === "invite") {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
            data: { participant_id: p.id, org_id: callerOrg },
            redirectTo,
          });
          if (error) throw error;
          newId = data.user?.id;
        } else {
          const password = genPassword();
          const { data, error } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true, // can log in immediately; no forced reset
            user_metadata: { participant_id: p.id, org_id: callerOrg },
          });
          if (error) throw error;
          newId = data.user?.id;
          // returned ONCE, never stored — the distribution artifact
          results.push({ participant_id: p.id, name: p.name, email, status: "created", password });
        }

        if (!newId) throw new Error("auth user creation returned no id");

        // profiles row so custom_access_token_hook can stamp org_id + role
        const { error: profErr } = await admin
          .from("profiles")
          .upsert(
            { id: newId, org_id: callerOrg, role: "participant", full_name: p.name },
            { onConflict: "id" },
          );
        if (profErr) throw profErr;

        // link the participant to its account
        const { error: linkErr } = await admin
          .from("participants")
          .update({ user_id: newId })
          .eq("id", p.id)
          .eq("org_id", callerOrg);
        if (linkErr) throw linkErr;

        if (mode === "invite") {
          invited++;
          results.push({ participant_id: p.id, name: p.name, email, status: "invited" });
        } else {
          created++;
        }
      } catch (e) {
        // best-effort cleanup so the row stays retryable (user_id is still null)
        if (newId) {
          try { await admin.auth.admin.deleteUser(newId); } catch (_) { /* ignore */ }
        }
        failed++;
        results.push({
          participant_id: p.id, name: p.name, email,
          status: "failed", reason: String((e as Error)?.message ?? e),
        });
      }
    }

    // --- 5. audit (no plaintext password ever lands in the diff) ---
    await admin.from("audit_log").insert({
      org_id: callerOrg,
      actor_id: user.id,
      action: mode === "invite" ? "credentials.invite" : "credentials.generate",
      entity: "cohort",
      entity_id: cohortId,
      diff: { mode, created, invited, skipped, failed, total: (targets ?? []).length },
    });

    return json({
      cohort: cohort.name,
      mode,
      total: (targets ?? []).length,
      created, invited, skipped, failed,
      results,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
