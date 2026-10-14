import { requireActor } from "@/lib/server-guards";
import { finishRecording, getRecording, isUuid } from "@/lib/recording-sessions";
import { json, readBody, sameOrigin } from "../../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Finalizing a take (head rewrite, storage reads) can take a few seconds.
export const maxDuration = 60;

/**
 * POST /api/recordings/<id>/finish  { interrupted?: true }
 *
 * The recorder is done: every part it captured is uploaded (or it gave up
 * waiting). Closes the take — 'interrupted' when sent from a closing tab
 * (sendBeacon, text body) — releases the room's lease, and finalizes the take
 * against storage before answering: { status, durationMs, parts }.
 * Only the take's own recorder. Idempotent.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "Forbidden" }, 403);
  const { id } = await props.params;
  const body = await readBody(req);
  if (!isUuid(id) || !body) return json({ error: "Bad request" }, 400);
  let userId: string;
  try {
    ({ userId } = await requireActor());
  } catch {
    return json({ error: "Sign in first." }, 401);
  }
  const row = await getRecording(id);
  if (!row || row.started_by !== userId) return json({ error: "Not found" }, 404);
  const done = await finishRecording(row, userId, body.interrupted === true ? "interrupted" : "finished");
  if (!done) return json({ error: "Couldn't save the recording yet. It will be retried." }, 503);
  return json({ status: done.status, durationMs: done.duration_ms, parts: done.part_count });
}
