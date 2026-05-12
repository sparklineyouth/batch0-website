import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Signout endpoint. POST-only + same-origin check. Without the origin
 * check, a hostile page could embed a form-POST that logs the user out
 * (annoyance + auth state confusion); the browser supplies Origin/Referer
 * on POST submissions and we reject anything cross-origin.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  function sameOrigin(value: string | null): boolean {
    if (!value) return false;
    try {
      const u = new URL(value);
      return u.origin === url.origin;
    } catch {
      return false;
    }
  }

  // At least one of Origin/Referer must match our origin. Modern browsers
  // send Origin on POSTs from forms; older Safari versions sometimes send
  // only Referer.
  if (!sameOrigin(origin) && !sameOrigin(referer)) {
    return NextResponse.json(
      { error: "Cross-origin signout blocked." },
      { status: 403 },
    );
  }

  const supabase = createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${url.origin}/`, { status: 303 });
}
