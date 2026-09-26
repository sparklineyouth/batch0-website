import { requireActor } from "@/lib/server-guards";
import { leaveInternal, type LiveRoomKind } from "@/lib/live-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Leave a live room from `pagehide` — the tab closing, a refresh, navigating
 * away.
 *
 * The same leave as the `leaveRoom` server action (both run `leaveInternal`
 * in lib/live-access.ts), in a shape a dying page can actually deliver. A
 * server action is a plain fetch with no `keepalive`, and fired from
 * `pagehide` the browser usually aborts it or queues it behind an in-flight
 * heartbeat — so markLeft and peer-offline rarely landed, hosts kept ghost
 * tiles until PEER_TIMEOUT_MS, and attendance rows stayed open. The client
 * calls `navigator.sendBeacon("/api/live/leave", …)` (falling back to
 * `fetch(…, { keepalive: true })`), which the browser guarantees to send after
 * the page is gone.
 *
 * Contract:
 *   POST /api/live/leave
 *   body  JSON `{ "kind": "event" | "call", "id": "<uuid>" }`, sent as any
 *         content type (sendBeacon with a string sends text/plain, which is
 *         what avoids a CORS preflight on an unloading page)
 *   auth  the session cookie — who is leaving is never taken from the body
 *   ->    204 on success AND on a well-formed no-op (not in that room, room
 *         gone): there is nobody left on the page to read an error.
 *         400 malformed body, 401 signed out, 403 cross-origin.
 *
 * IDENTITY ONLY, like leaveRoom: the only writes are the caller's own
 * attendance row and a peer-offline for the caller's own id. It must not be
 * window- or status-gated, because the moments people leave — after End,
 * after the window, after a cancel — are exactly the moments a gate would
 * refuse.
 *
 * Why it checks Origin: cookies ride along on cross-site POSTs, so without the
 * check any page on the web could mark a signed-in batch0 user as having left
 * a webinar (low impact — attendance and a host-side tile — but free to
 * prevent). Same-origin only; a request that carries neither Origin nor
 * Sec-Fetch-Site is refused rather than trusted.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return new Response(null, { status: 403 });
  }

  let kind: LiveRoomKind;
  let id: string;
  try {
    const parsed = JSON.parse(await req.text()) as { kind?: unknown; id?: unknown };
    if (parsed.kind !== "event" && parsed.kind !== "call") throw new Error();
    if (typeof parsed.id !== "string" || parsed.id.length > 64) throw new Error();
    kind = parsed.kind;
    id = parsed.id;
  } catch {
    return new Response(null, { status: 400 });
  }

  let userId: string;
  try {
    ({ userId } = await requireActor());
  } catch {
    return new Response(null, { status: 401 });
  }

  try {
    await leaveInternal(kind, id, userId);
  } catch (err) {
    // Best-effort by nature — the page that sent this is already gone, and
    // the heartbeat timeout remains the backstop.
    console.error("[live/leave] leave failed", err);
  }
  return new Response(null, { status: 204 });
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    // Behind Vercel's proxy the request URL, Host and X-Forwarded-Host all
    // name the public host; accept a match against any of them.
    const hosts = [
      new URL(req.url).host,
      req.headers.get("host"),
      req.headers.get("x-forwarded-host"),
    ].filter(Boolean);
    return hosts.includes(originHost);
  }
  // No Origin header (some browsers omit it on same-origin beacons): fall back
  // to Fetch Metadata, which every current browser sends and a page cannot
  // forge.
  return req.headers.get("sec-fetch-site") === "same-origin";
}
