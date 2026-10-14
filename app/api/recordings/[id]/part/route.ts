import { requireActor } from "@/lib/server-guards";
import { getRecording, heartbeat, isUuid, mintPart } from "@/lib/recording-sessions";
import { PART_MAX_BYTES, RECORDING_BUCKET } from "@/lib/recording-parts";
import { json, readBody, sameOrigin } from "../../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/recordings/<id>/part — the recorder's lease, kept alive.
 *
 *   { index, size, endMs, cues }  report part `index` (its byte size, the
 *                                 recorded time at its end, keyframe Clusters
 *                                 found in it) and get a signed upload URL
 *                                 for it: { bucket, path, token }. Parts go
 *                                 in order; `index` may repeat the last one
 *                                 (a retry), never skip ahead.
 *   { heartbeat: true }           renew the lease while uploads are behind.
 *
 * Only the take's own recorder, only while it is recording. 409 means the take
 * is over or no longer this browser's (swept after its heartbeat went stale):
 * the recorder stops.
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
  if (!row) return json({ error: "Not found" }, 404);

  if (body.heartbeat === true) {
    return (await heartbeat(row, userId)) ? json({ ok: true }) : json({ error: "This recording has stopped." }, 409);
  }

  const { index, size, endMs, cues } = body;
  if (
    typeof index !== "number" ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > PART_MAX_BYTES * 2 ||
    typeof endMs !== "number" ||
    !Number.isFinite(endMs) ||
    endMs < 0 ||
    (cues !== undefined && (!Array.isArray(cues) || cues.length > 100))
  ) {
    return json({ error: "Bad request" }, 400);
  }
  const minted = await mintPart(row, userId, {
    index,
    size,
    endMs,
    cues: (cues as [number, number][] | undefined) ?? [],
  });
  if (!minted.ok) return json({ error: minted.message }, minted.status);
  return json({ bucket: RECORDING_BUCKET, path: minted.path, token: minted.token });
}
