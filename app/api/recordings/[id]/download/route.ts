import {
  auditRecordingView,
  getRecording,
  isUuid,
  signedDownloadParts,
  viewAccess,
} from "@/lib/recording-sessions";
import { containerFor, contentTypeFor, downloadName } from "@/lib/recording-parts";
import { json } from "../../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/recordings/<id>/download — the manifest for a client-side download:
 *
 *   { filename, type, size, head: { url, size } | null,
 *     parts: [{ url, size, skip }] }
 *
 * The browser fetches each signed URL (15 minutes) in order, drops `skip`
 * bytes from the front of each (part 0 loses the bytes the head replaces),
 * and writes the result to one file. Hundreds of megabytes never pass through
 * a function. Same access rule as playback.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!isUuid(id)) return json({ error: "Not found" }, 404);
  const row = await getRecording(id);
  if (!row) return json({ error: "Not found" }, 404);
  const access = await viewAccess(row.room_kind, row.room_id);
  if (!access?.canView) return json({ error: "Not found" }, 404);
  const container = containerFor(row.mime);
  if (!row.finalized_at || row.part_count === 0 || !container) {
    return json({ error: "Not ready yet." }, 409);
  }
  const signed = await signedDownloadParts(row);
  if (!signed) return json({ error: "Couldn't prepare the download. Try again." }, 503);
  await auditRecordingView(row, access);
  const replaces = row.head_bytes !== null ? (row.head_replaces ?? 0) : 0;
  return json({
    filename: downloadName(row.title, row.started_at, container),
    type: contentTypeFor(container),
    size: Number(row.total_bytes),
    head: signed.head ? { url: signed.head, size: row.head_bytes } : null,
    parts: signed.parts.map((url, i) => ({
      url,
      size: row.part_sizes[i],
      skip: i === 0 ? replaces : 0,
    })),
  });
}
