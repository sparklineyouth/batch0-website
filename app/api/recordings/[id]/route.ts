import { requireActor } from "@/lib/server-guards";
import { can } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { deleteRecording, getRecording, isUuid } from "@/lib/recording-sessions";
import { json, sameOrigin } from "../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A long take is hundreds of objects to remove.
export const maxDuration = 60;

/**
 * DELETE /api/recordings/<id> — remove a take for good: its bytes, then its
 * row. Staff only — events.manage for a webinar's, admins for a call's (the
 * people who can see every call) — never while it is still recording.
 * Audited.
 */
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "Forbidden" }, 403);
  const { id } = await props.params;
  if (!isUuid(id)) return json({ error: "Not found" }, 404);
  let actor: Awaited<ReturnType<typeof requireActor>>;
  try {
    actor = await requireActor();
  } catch {
    return json({ error: "Sign in first." }, 401);
  }
  const row = await getRecording(id);
  if (!row) return json({ error: "Not found" }, 404);
  const allowed =
    row.room_kind === "webinar" ? can(actor.caps, "events.manage") : actor.caps.superAdmin;
  if (!allowed) return json({ error: "Not found" }, 404);
  if (row.status === "recording") return json({ error: "Stop the recording first." }, 409);
  if (!(await deleteRecording(row))) return json({ error: "Couldn't delete it. Try again." }, 503);
  await logAudit({
    action: "recording.deleted",
    targetType: "recording_session",
    targetId: row.id,
    payload: {
      kind: row.room_kind,
      roomId: row.room_id,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      by: row.started_by,
    },
  });
  return json({ ok: true });
}
