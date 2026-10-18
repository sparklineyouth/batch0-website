import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { sameOrigin } from "@/lib/same-origin";
import { loadAssignmentDraft } from "@/lib/assignments-server";
import { draftAuthor, saveDraftAs } from "@/lib/assignment-drafts-server";
import type { DraftSaveResult, DraftState } from "@/lib/assignment-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every answer here is one student's own work. */
function json(body: unknown, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

/**
 * A student's private assignment draft (migration 0105, lib/assignment-drafts.ts).
 *
 *   GET  → the draft and the submission as they stand now (DraftState), for
 *          a form whose page came out of the router cache (Back/Forward
 *          shows the first visit's payload) or that was just told "stale".
 *   POST → autosave. Body JSON `{ body, linkUrl, baseVersion }`; answers a
 *          DraftSaveResult. 401 only when Auth rejected the session.
 *
 * A route rather than a server action, for two reasons a server action can't
 * meet. The form sends a save as the page closes, which only a keepalive
 * request survives (lib/assignment-drafts-client.ts). And a server action
 * posts to the page's own URL, so for a signed-out student middleware
 * redirected it to /login and the form saw an unreadable response — it said
 * "retrying" forever. /api isn't behind the sign-in redirect, so here a
 * signed-out session is a 401 the form can name.
 *
 * Owner-only both ways: the read goes through the student's own client (the
 * drafts policy is the owner's alone; submissions are read the same way the
 * assignment page reads them), and the write takes the user from the session,
 * never from the body.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!UUID.test(id)) return json({ error: "not_found" }, 404);
  const user = await getUser();
  if (!user) return json({ error: "signed_out" }, 401);

  const supabase = await createClient();
  const [draft, { data: submission, error }] = await Promise.all([
    loadAssignmentDraft(supabase, user.id, id),
    supabase
      .from("course_assignment_submissions")
      .select("body, link_url, submitted_at")
      .eq("assignment_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  if (draft.state === "not_ready") return json({ state: "not_ready" } satisfies DraftState);
  if (draft.state === "failed" || error) return json({ error: "unavailable" }, 503);
  return json({ state: "ready", draft: draft.row, submission: submission ?? null } satisfies DraftState);
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ ok: false, reason: "error" } satisfies DraftSaveResult, 403);
  const { id } = await props.params;

  let input: { body?: unknown; linkUrl?: unknown; baseVersion?: unknown };
  try {
    const text = await req.text();
    // Twice the largest draft, generously: a body past this is not the form.
    if (text.length > 64 * 1024) throw new Error("too large");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as typeof input;
  } catch {
    return json({ ok: false, reason: "error" } satisfies DraftSaveResult, 400);
  }

  const who = await draftAuthor();
  if ("code" in who) {
    return who.code === "signed_out"
      ? json({ ok: false, reason: "signed_out" } satisfies DraftSaveResult, 401)
      : json({ ok: false, reason: "error" } satisfies DraftSaveResult, 503);
  }
  return json(
    await saveDraftAs(who.userId, {
      assignmentId: id,
      body: input.body,
      linkUrl: input.linkUrl,
      baseVersion: input.baseVersion,
    }),
  );
}
