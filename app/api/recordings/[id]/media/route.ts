import {
  auditRecordingView,
  fetchObjectRange,
  finalizeRecording,
  getRecording,
  isUuid,
  layoutOf,
  sweepStaleRecordings,
  viewAccess,
  type RecordingRow,
} from "@/lib/recording-sessions";
import {
  capRange,
  containerFor,
  contentTypeFor,
  downloadName,
  HEAD_NAME,
  isStale,
  mapRange,
  parseRange,
  partName,
  servedLength,
  type Piece,
} from "@/lib/recording-parts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET|HEAD /api/recordings/<id>/media — one take as ONE file.
 *
 * The take is stored as numbered parts plus (WebM) a rewritten head; this
 * serves them as the single stitched file the player sees: Range requests
 * are mapped across the head and the parts (lib/recording-parts.ts) and each
 * piece is streamed from Storage with a Range of its own. Every 206 is capped
 * at RANGE_CAP_BYTES, which players handle by asking again, and which keeps
 * each response under Vercel's body limit. A request without Range gets the
 * file if it is that small, else the first capped slice.
 *
 * Auth is re-checked on every request (viewAccess): a link that leaks is a
 * 404 to anyone not entitled to the room. A call watched by someone not on it
 * is audited once per view.
 */
export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  return serve(req, (await props.params).id, false);
}

export async function HEAD(req: Request, props: { params: Promise<{ id: string }> }) {
  return serve(req, (await props.params).id, true);
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

async function serve(req: Request, id: string, headOnly: boolean): Promise<Response> {
  if (!isUuid(id)) return notFound();
  let row = await getRecording(id);
  if (!row) return notFound();
  const access = await viewAccess(row.room_kind, row.room_id);
  if (!access?.canView) return notFound();

  if (row.status === "recording") {
    if (!isStale(row.heartbeat_at)) {
      return new Response("Still recording.", { status: 409, headers: { "Cache-Control": "private, no-store" } });
    }
    await sweepStaleRecordings({ kind: row.room_kind, roomId: row.room_id });
    row = await getRecording(id);
    if (!row) return notFound();
  }
  if (!row.finalized_at) row = (await finalizeRecording(row)) ?? row;
  const container = containerFor(row.mime);
  if (!row.finalized_at || row.status === "failed" || row.part_count === 0 || !container) {
    return notFound();
  }

  const layout = layoutOf(row);
  const total = servedLength(layout);
  const asked = parseRange(req.headers.get("range"), total);
  const base = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Type": contentTypeFor(container),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(
      downloadName(row.title, row.started_at, container),
    )}`,
  };
  if (asked === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${total}` } });
  }
  const range = capRange(asked ?? { start: 0, end: total - 1 });
  const partial = asked !== null || range.end < total - 1;
  const headers: Record<string, string> = {
    ...base,
    "Content-Length": String(range.end - range.start + 1),
  };
  if (partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${total}`;
  const status = partial ? 206 : 200;
  if (headOnly) return new Response(null, { status, headers });

  if (range.start === 0) await auditRecordingView(row, access);

  const pieces = mapRange(layout, range.start, range.end);
  const paths = pieces.map((p) => pathOf(row!, p, container));
  // The first piece is fetched before answering, so a Storage failure is a
  // clean 502 rather than a 206 that dies after its headers.
  const first = await fetchObjectRange(paths[0], pieces[0].from, pieces[0].to).catch(() => null);
  if (!first || !first.ok || !first.body) {
    return new Response("Couldn't read the recording. Try again.", {
      status: 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const chunks = streamPieces(pieces, paths, first);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        console.error("[recordings] media stream failed", id, err);
        controller.error(err);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(body, { status, headers });
}

function pathOf(row: RecordingRow, p: Piece, container: "webm" | "mp4"): string {
  return p.source === "head"
    ? `${row.storage_prefix}/${HEAD_NAME}`
    : `${row.storage_prefix}/${partName(p.index, container)}`;
}

/** The pieces' bytes, in order, exactly `to - from + 1` of each. */
async function* streamPieces(
  pieces: Piece[],
  paths: string[],
  first: Response,
): AsyncGenerator<Uint8Array, void, undefined> {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const res = i === 0 ? first : await fetchObjectRange(paths[i], p.from, p.to);
    if (!res.ok || !res.body) throw new Error(`storage ${res.status} for ${paths[i]}`);
    // A 200 is the whole object: skip to `from` ourselves.
    let skip = res.status === 206 ? 0 : p.from;
    let left = p.to - p.from + 1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      let c = chunk;
      if (skip > 0) {
        const drop = Math.min(skip, c.length);
        c = c.subarray(drop);
        skip -= drop;
      }
      if (c.length === 0) continue;
      if (c.length > left) c = c.subarray(0, left);
      left -= c.length;
      yield c;
      if (left === 0) break;
    }
    if (left > 0) throw new Error(`short read of ${paths[i]}`);
  }
}
