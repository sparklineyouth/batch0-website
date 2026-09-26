import { NextResponse } from "next/server";
import { requireUser, getViewer } from "@/lib/auth";
import { getInvite } from "@/lib/calls";
import { logAudit } from "@/lib/audit";
import { canViewCallRecording } from "@/lib/call-lifecycle";
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
 * Who may: the two people on the call, and admins (canViewCallRecording). A
 * stranger gets the same 404 as a call that does not exist — the id of a
 * minor's private call is not something to confirm. An admin watching a call
 * they were not on is audited, because that is the safeguarding access this
 * rule exists to allow, and it should leave a trace.
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

  if (viewerId !== invite.hostId && viewerId !== invite.inviteeId) {
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
