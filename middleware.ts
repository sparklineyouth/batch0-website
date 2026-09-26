import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { CAMPAIGN_COOKIE, CAMPAIGN_MAX_AGE, newCampaignCookie } from "@/lib/campaign-attribution";

export async function middleware(request: NextRequest) {
  const response = await updateSession(request);
  // Server-side capture survives signup redirects and does not require a
  // third-party pixel, JavaScript, or reading cookies in static marketing pages.
  const prefetch = request.headers.has("next-router-prefetch") ||
    [request.headers.get("purpose"), request.headers.get("sec-purpose")].some(v => v?.includes("prefetch"));
  if (request.method === "GET" && !prefetch) {
    const value = newCampaignCookie(request.nextUrl, request.cookies.get(CAMPAIGN_COOKIE)?.value);
    if (value) response.cookies.set(CAMPAIGN_COOKIE, value, {
      httpOnly: true, secure: request.nextUrl.protocol === "https:",
      sameSite: "lax", path: "/", maxAge: CAMPAIGN_MAX_AGE,
    });
  }
  return response;
}

export const config = {
  // Excluded from middleware entirely: Next.js internals, static assets by
  // extension (txt/xml cover the prerendered robots.txt, sitemap.xml and
  // llms.txt), the three webhooks that authenticate by signature instead of
  // session, and the demo-day reaction endpoint — its GET is anonymous and
  // its POST authenticates via its own Supabase client, so like the webhooks
  // it forgoes proactive token refresh rather than paying full session work
  // on a 4-second poll.
  matcher: [
    // manifest.webmanifest is named explicitly because its extension isn't in
    // the list below. It is a static, viewer-independent file that the browser
    // fetches on every install check and every launch of the installed app —
    // there is nothing for a session refresh to do on it.
    "/((?!_next/static|_next/image|favicon.ico|logo.svg|og.png|manifest.webmanifest|api/stripe/webhook|api/discord/interactions|api/resend/webhook|api/demo-day/reactions|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|txt|xml)$).*)",
  ],
};
