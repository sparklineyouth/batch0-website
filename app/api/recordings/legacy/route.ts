import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { isRecordingKind, isUuid, viewAccess } from "@/lib/recording-sessions";
import { legacyRecording, signLegacyPart } from "@/lib/recording-legacy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recordings/legacy?kind=webinar|call&room=<id>&part=<n>  (n from 1)
 *
 * One segment of a recording made before one-take recording, for the legacy
 * player: checked against the room (viewAccess), then a 302 to a ten-minute
 * signed URL minted now. 404 for anyone not allowed, and for no such part.
 * A call watched by someone who was not on it (an admin) is audited, once per
 * part — on the request that starts it, not on every range the player asks
 * for after that.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const room = url.searchParams.get("room");
  const n = Number(url.searchParams.get("part"));
  const notFound = () => new Response("Not found", { status: 404 });
  if (!isRecordingKind(kind) || !isUuid(room) || !Number.isInteger(n) || n < 1) return notFound();

  const access = await viewAccess(kind, room);
  if (!access?.canView) return notFound();
  const part = (await legacyRecording(kind, room))[n - 1];
  if (!part) return notFound();
  const signed = await signLegacyPart(part);
  if (!signed) return new Response("That recording couldn't be opened. Try again.", { status: 503 });

  const range = req.headers.get("range");
  if (kind === "call" && !access.party && (!range || /^bytes=0-/.test(range))) {
    await logAudit({
      action: "call_recording.viewed",
      targetType: "call_invite",
      targetId: room,
      payload: { part: n },
    });
  }
  const res = NextResponse.redirect(signed, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
