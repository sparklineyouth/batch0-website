/**
 * Same-origin only, for a route handler that writes on the session cookie.
 *
 * A server action gets this check from Next; a plain route doesn't, and
 * cookies ride along on cross-site POSTs. Origin when the browser sends one;
 * otherwise Fetch Metadata, which every current browser sends and a page
 * can't forge (a keepalive or beacon request may omit Origin). A request
 * carrying neither is refused rather than trusted. The same rule as
 * app/api/live/leave and app/api/recordings/http.ts.
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
    // Behind Vercel's proxy the request URL, Host and X-Forwarded-Host all
    // name the public host; accept a match against any of them.
    return [new URL(req.url).host, req.headers.get("host"), req.headers.get("x-forwarded-host")]
      .filter(Boolean)
      .includes(host);
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}
