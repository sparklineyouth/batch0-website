import { gateRoom } from "@/lib/webinar-gate";
import { loadPanelState } from "@/lib/webinar-data";
import {
  isIsoTimestamp,
  isUuid,
  PANEL_PARTS,
  type PanelPart,
} from "@/lib/webinar-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the webinar side panel (chat, questions, polls) for the signed-in
 * caller.
 *
 *   GET /api/live/panel?event=<uuid>[&since=<iso>][&parts=chat,qa,poll]
 *   ->  200 PanelRead (lib/webinar-panel.ts), shaped by the caller's role
 *       204 not in this room right now (window closed, no access) — nothing to draw
 *       400 malformed, 401 signed out, 403 cross-site, 503 couldn't tell
 *
 * A route rather than a server action because Next runs a page's server
 * actions one at a time: reads fired by every realtime hint would queue a
 * chat send behind them. Same gate as the room's actions (lib/webinar-gate.ts);
 * read-only, so the session cookie is the whole of the auth.
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
    const signedOut = err instanceof Error && err.message === "Not signed in";
    return new Response(null, { status: signedOut ? 401 : 503 });
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

function parseParts(raw: string | null): PanelPart[] | null {
  if (raw === null) return [...PANEL_PARTS];
  const parts = raw.split(",").filter(Boolean);
  if (parts.length === 0) return null;
  return parts.every((p): p is PanelPart => (PANEL_PARTS as readonly string[]).includes(p))
    ? [...new Set(parts)]
    : null;
}
