import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser as getVerifiedTokenUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { isMissingSchemaError } from "@/lib/schema-ready";
import {
  authRejectedSession,
  checkDraft,
  interpretDraftSave,
  type DraftSaveResult,
} from "@/lib/assignment-drafts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who is saving a draft.
 *
 * getUser() — a round trip to Supabase Auth — is the authority, as it is for
 * every write (lib/server-guards.ts says why): a deleted or signed-out account
 * stops at once, and a 401/403 or a missing session is exactly that. What it
 * must not do is read an Auth outage as a sign-out. supabase-js returns
 * `user: null` for a network failure or a 5xx too, and requireActor() turns
 * both into "Not signed in" — which, for a save that runs every few seconds
 * while someone types, stopped autosave for the rest of the visit and told a
 * signed-in student to sign in again.
 *
 *   - Auth rejects the session → signed_out (the form stops and says so).
 *   - Auth errors any other way → once more, then the session's locally
 *     verified token (lib/auth getUser, getClaims — what every page trusts).
 *     The draft is the student's own row, and the save function re-checks
 *     enrolment and access itself; a deleted account never gets this far,
 *     since Auth answers that with a 403, not an outage.
 *   - Nothing at all → unavailable (the form retries).
 *
 * The same shape as app/apply/actions.ts resolveSessionUser, for the same
 * reason.
 */
export async function draftAuthor(): Promise<{ userId: string } | { code: "signed_out" | "unavailable" }> {
  const supabase = await createClient();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error } = await supabase.auth.getUser();
    if (data.user) return { userId: data.user.id };
    if (authRejectedSession(error)) return { code: "signed_out" };
    console.warn(
      `[assignments] draft auth check failed (attempt ${attempt})`,
      (error as { status?: number } | null)?.status ?? "(no status)",
      error?.message,
    );
  }
  const tokenUser = await getVerifiedTokenUser();
  if (tokenUser) return { userId: tokenUser.id };
  return { code: "unavailable" };
}

/**
 * Autosave one student's unsubmitted work as their private draft (migration
 * 0105). Never a submission: nothing here touches
 * course_assignment_submissions, notifies anyone, or revalidates a page.
 *
 * Access is re-checked on every save inside save_course_assignment_draft()
 * (open, enrolled, targeted, cohort started, not reviewed or excused), so a
 * student who loses access stops being able to save on the next keystroke.
 * `baseVersion` is the draft version this text was typed on top of; a tab
 * holding an older one gets `stale` and nothing is written.
 *
 * Returns a reason code rather than throwing: it runs in the background while
 * someone types, and the form has to say what happened.
 */
export async function saveDraftAs(
  userId: string,
  input: { assignmentId: string; body?: unknown; linkUrl?: unknown; baseVersion?: unknown },
): Promise<DraftSaveResult> {
  if (typeof input.assignmentId !== "string" || !UUID.test(input.assignmentId)) {
    return { ok: false, reason: "forbidden" };
  }
  const checked = checkDraft({
    body: typeof input.body === "string" ? input.body : null,
    link: typeof input.linkUrl === "string" ? input.linkUrl : null,
  });
  if (!checked.ok) return { ok: false, reason: "too_long" };
  const base =
    typeof input.baseVersion === "number" && Number.isInteger(input.baseVersion) && input.baseVersion > 0
      ? input.baseVersion
      : 0;

  // Generous: a save waits for a two-second pause in typing, so a person
  // can't come near this. It stops a runaway client, not a fast typist.
  const rl = await checkRateLimit({
    kind: "assignment-draft",
    identifier: userId,
    limit: 2000,
    windowSeconds: 3600,
  });
  if (!rl.ok) return { ok: false, reason: "rate_limited" };

  try {
    const { data, error } = await createAdminClient().rpc("save_course_assignment_draft", {
      p_user_id: userId,
      p_assignment_id: input.assignmentId,
      p_body: checked.body,
      p_link_url: checked.link,
      p_base_version: base,
    });
    if (error) {
      // 0105 not run yet (no function / table in the schema cache).
      if (isMissingSchemaError(error) || error.code === "PGRST202") return { ok: false, reason: "not_ready" };
      console.error("[assignments] draft save failed", input.assignmentId, error.message);
      return { ok: false, reason: "error" };
    }
    return interpretDraftSave(data);
  } catch (err) {
    console.error("[assignments] draft save failed", input.assignmentId, err);
    return { ok: false, reason: "error" };
  }
}
