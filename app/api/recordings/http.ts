import { NextResponse } from "next/server";

/**
 * Shared bits of the /api/recordings route handlers. Not a route (no
 * route.ts): Next only serves `route.ts` files.
 *
 * The recording control plane is route handlers rather than server actions
 * because a page's actions run one at a time: a part upload queued behind a
 * heartbeat or a chat send stalls the recorder, and an action that revalidates
 * would re-render the live room mid-call. None of these revalidate anything.
 */

/** JSON with `Cache-Control: private, no-store` — every answer here is per-user. */
export function json(body: unknown, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

/**
 * Same-origin only for anything that writes. Cookies ride along on cross-site
 * requests; this refuses them. Same check as /api/live/leave: Origin when
 * present, else Fetch Metadata (a beacon may omit Origin).
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    return [new URL(req.url).host, req.headers.get("host"), req.headers.get("x-forwarded-host")]
      .filter(Boolean)
      .includes(host);
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/** A small JSON body, read as text (sendBeacon posts text/plain). Null if malformed. */
export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 64 * 1024) return null;
    const parsed = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
