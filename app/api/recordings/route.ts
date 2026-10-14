import { requireActor } from "@/lib/server-guards";
import { containerFor } from "@/lib/recording-parts";
import {
  isRecordingKind,
  isUuid,
  listRecordings,
  recordAccess,
  startRecording,
  viewAccess,
} from "@/lib/recording-sessions";
import { legacyRecording } from "@/lib/recording-legacy";
import { json, readBody, sameOrigin } from "./http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Finalizing a take (head rewrite, storage reads) can take a few seconds.
export const maxDuration = 60;

/**
 * GET  /api/recordings?kind=webinar|call&room=<id>
 *   A room's recordings for someone allowed to watch them (viewAccess):
 *   { recordings: RecordingSummary[], legacy: { parts } | null, canDelete }.
 *   404 for anyone else — the existence of a minor's call is not confirmed.
 *
 * POST /api/recordings  { kind, roomId, mime, auto?, replaces? }
 *   Take the room's recording lease and open a take (recordAccess decides
 *   who may). 201 { sessionId } · 409 { by: { id, name }, sessionId,
 *   startedAt } when someone is recording (this person elsewhere included,
 *   unless `replaces` names that take: the same tab, reloaded) · 409
 *   { stopped: true } when `auto` and the room's last take was stopped on
 *   purpose · 503 { unavailable: true } before migration 0095 is applied.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const room = url.searchParams.get("room");
  if (!isRecordingKind(kind) || !isUuid(room)) return json({ error: "Bad request" }, 400);
  const access = await viewAccess(kind, room);
  if (!access) return json({ error: "Not found" }, 404);
  if (!access.canView) return json({ error: "Not found" }, 404);
  const [recordings, legacy] = await Promise.all([
    listRecordings(kind, room),
    legacyRecording(kind, room, { startsAt: access.startsAt }),
  ]);
  return json({
    recordings,
    legacy: legacy.length > 0 ? { parts: legacy.map((p) => ({ seconds: p.seconds })) } : null,
    canDelete: access.canDelete,
  });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Forbidden" }, 403);
  const body = await readBody(req);
  const kind = body?.kind;
  const roomId = body?.roomId;
  const mime = body?.mime;
  const replaces = body?.replaces;
  if (
    !isRecordingKind(kind) ||
    !isUuid(roomId) ||
    !containerFor(mime) ||
    (replaces !== undefined && replaces !== null && !isUuid(replaces))
  ) {
    return json({ error: "Bad request" }, 400);
  }
  try {
    await requireActor();
  } catch {
    return json({ error: "Sign in first." }, 401);
  }
  const access = await recordAccess(kind, roomId);
  if (!access.ok) return json({ error: access.message }, access.status);
  const started = await startRecording({
    kind,
    roomId,
    userId: access.userId,
    mime: mime as string,
    title: access.title,
    auto: body?.auto === true,
    replaces: (replaces as string | null | undefined) ?? null,
    startsAt: access.startsAt,
  });
  if (started.ok) return json({ sessionId: started.sessionId }, 201);
  if (started.reason === "busy") {
    return json(
      {
        by: { id: started.by.byUserId, name: started.by.byName },
        sessionId: started.by.sessionId,
        startedAt: started.by.startedAt,
      },
      409,
    );
  }
  if (started.reason === "stopped") return json({ stopped: true }, 409);
  if (started.reason === "unavailable") return json({ unavailable: true }, 503);
  return json({ error: "Couldn't start recording. Try again." }, 503);
}
