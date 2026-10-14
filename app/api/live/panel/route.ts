import { gateRoom } from "@/lib/webinar-gate";
import { loadPanelState } from "@/lib/webinar-data";
import { runPanelWrite } from "@/lib/webinar-panel-writes";
import { requireActor } from "@/lib/server-guards";
import {
  isIsoTimestamp,
  isUuid,
  parsePanelOp,
  PANEL_PARTS,
  PANEL_READ_PARTS,
  type PanelReadPart,
} from "@/lib/webinar-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The webinar side panel's reads and writes, for the signed-in caller.
 *
 *   GET  /api/live/panel?event=<uuid>[&since=<iso>][&parts=chat,qa,poll|people]
 *   ->   200 PanelRead (lib/webinar-panel.ts), shaped by the caller's role
 *        204 not in this room right now (window closed, no access) — nothing to draw
 *        400 malformed, 401 signed out, 403 cross-site, 503 couldn't tell
 *
 *   POST /api/live/panel   JSON { event: <uuid>, op: PanelOp["op"], ...args }
 *   ->   200 PanelWrite (ok, or the refusal to show and whether to retry)
 *        400 malformed, 401 signed out, 403 cross-site, 413 too large
 *
 * A route rather than server actions because Next runs a page's server
 * actions one at a time: a chat send would otherwise wait behind the engine's
 * heartbeat and the room's polls. Same gate as everything else in the room
 * (lib/webinar-gate.ts), re-run on every request; who is asking always comes
 * from the session cookie, never the body.
 */
export async function GET(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return new Response(null, { status: 403 });
  }

  const params = new URL(req.url).searchParams;
  const eventId = params.get("event");
  const since = params.get("since");
  const parts = parseParts(params.get("parts"));
  if (!isUuid(eventId) || (since !== null && !isIsoTimestamp(since)) || !parts) {
    return new Response(null, { status: 400 });
  }

  let gate;
  try {
    gate = await gateRoom(eventId, { throwOnError: true });
  } catch (err) {
    return new Response(null, { status: signedOut(err) ? 401 : 503 });
  }
  if (!gate) return new Response(null, { status: 204 });

  const read = await loadPanelState(
    {
      eventId,
      userId: gate.userId,
      audienceMode: gate.audienceMode,
      isModerator: gate.isModerator,
      discloseNames: gate.discloseNames,
    },
    { parts, since },
  );
  return Response.json(read, { headers: { "Cache-Control": "no-store" } });
}

const MAX_WRITE_BYTES = 16 * 1024;

export async function POST(req: Request) {
  // Cookies ride along on cross-site POSTs; server actions check Origin for
  // the same reason.
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WRITE_BYTES) {
    return new Response(null, { status: 413 });
  }

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_WRITE_BYTES) return new Response(null, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  const eventId = (body as { event?: unknown } | null)?.event;
  const op = parsePanelOp(body);
  if (!isUuid(eventId) || !op) return new Response(null, { status: 400 });

  try {
    await requireActor();
  } catch (err) {
    return new Response(null, { status: signedOut(err) ? 401 : 503 });
  }

  const result = await runPanelWrite(eventId, op);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

function parseParts(raw: string | null): PanelReadPart[] | null {
  if (raw === null) return [...PANEL_PARTS];
  const parts = raw.split(",").filter(Boolean);
  if (parts.length === 0) return null;
  return parts.every((p): p is PanelReadPart =>
    (PANEL_READ_PARTS as readonly string[]).includes(p),
  )
    ? [...new Set(parts)]
    : null;
}

function signedOut(err: unknown): boolean {
  return err instanceof Error && err.message === "Not signed in";
}

/** Origin matches this host; failing that, Fetch Metadata says same-origin. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const hosts = [
      new URL(req.url).host,
      req.headers.get("host"),
      req.headers.get("x-forwarded-host"),
    ].filter(Boolean);
    return hosts.includes(originHost);
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}
