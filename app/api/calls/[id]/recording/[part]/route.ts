import { NextResponse } from "next/server";
import { requireUser, getViewer } from "@/lib/auth";
import { getInvite } from "@/lib/calls";
import { logAudit } from "@/lib/audit";
import { canViewCallRecording } from "@/lib/call-lifecycle";
import { isOnCall } from "@/lib/live";
import { isUuid } from "@/lib/call-recording";
import {
  listCallRecording,
  signCallRecordingPart,
} from "@/lib/call-recordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Play one part of a 1:1 call's recording.
 *
 *   /api/calls/<id>/recording/1   → the first segment, and so on
 *
 * The link on the calls page points here rather than at Storage, the same
 * move /dashboard/resources/open/[id] makes: the signed URL is minted at the
 * moment of the click, after the check, so a page left open for a day never
 * hands out a dead link and a link copied out of the page is worthless on its
 * own.
 *
 * Who may: the people on the call — the student, the host and any co-hosts —
 * and admins (canViewCallRecording). A stranger gets the same 404 as a call
 * that does not exist — the id of a minor's private call is not something to
 * confirm. An admin watching a call they were not on is audited, because that
 * is the safeguarding access this rule exists to allow, and it should leave a
 * trace.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string; part: string }> },
) {
  const { id, part } = await props.params;
  await requireUser();
  const viewer = await getViewer();
  const notFound = () => new Response("Not found", { status: 404 });
  if (!viewer || !isUuid(id)) return notFound();

  const n = Number(part);
  if (!Number.isInteger(n) || n < 1) return notFound();

  const invite = await getInvite(id);
  if (!invite) return notFound();
  const viewerId = viewer.profile.id;
  if (
    !canViewCallRecording({
      viewerId,
      hostId: invite.hostId,
      inviteeId: invite.inviteeId,
      cohostIds: invite.cohosts.map((c) => c.id),
      superAdmin: viewer.caps.superAdmin,
    })
  ) {
    return notFound();
  }

  const parts = await listCallRecording(id);
  const file = parts[n - 1];
  if (!file) return notFound();

  const url = await signCallRecordingPart(file.path);
  if (!url) {
    return new Response("That recording couldn't be opened. Try again.", {
      status: 503,
    });
  }

  // Audited only when the viewer was NOT on the call: a co-host watching back
  // a meeting they sat in is not the safeguarding access this trace is for.
  if (!isOnCall(invite, viewerId)) {
    await logAudit({
      action: "call_recording.viewed",
      targetType: "call_invite",
      targetId: id,
      payload: { part: n },
    });
  }

  const res = NextResponse.redirect(url, 302);
  // Per-user and auth-gated — a shared cache must never hold the redirect.
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
