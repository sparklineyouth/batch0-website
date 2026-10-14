import { activeRecordingFor, isRecordingKind, isUuid, viewAccess } from "@/lib/recording-sessions";
import { json } from "../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recordings/active?kind=webinar|call&room=<id>
 *   { recording: { sessionId, byUserId, byName, startedAt } | null }
 *
 * Whether the room is being recorded right now, for everyone in it — the REC
 * badge and the green-room notice. Anyone who can see the webinar; the people
 * on a call (and admins). 404 otherwise.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const room = url.searchParams.get("room");
  if (!isRecordingKind(kind) || !isUuid(room)) return json({ error: "Bad request" }, 400);
  const access = await viewAccess(kind, room);
  const allowed = kind === "webinar" ? access !== null : !!access?.canView;
  if (!allowed) return json({ error: "Not found" }, 404);
  return json({ recording: await activeRecordingFor(kind, room) });
}
