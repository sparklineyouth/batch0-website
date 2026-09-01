"use client";
import { useEffect, useState } from "react";
import { AUTH_COOKIE, AUTH_FLAG_ATTR } from "@/lib/auth-flag";

/**
 * Whether the visitor is signed in, resolved in the browser.
 *
 * Deliberately a raw cookie test rather than `createBrowserClient().auth
 * .getSession()`. The SDK call is also a local read, but *importing* it drags
 * auth-js, postgrest-js, realtime-js, storage-js and functions-js into the
 * shared client chunk — measured at 243 KB raw / 54 KB brotli on a live blog
 * article, on pages whose entire reason for existing in this changeset is to
 * be fast. Nothing in the marketing tree needs a Supabase client; it needs one
 * boolean.
 *
 * False on the server and on the first client render so SSR and hydration
 * agree; it flips one tick later. Anything that must be *right on the first
 * painted frame* — a label, a button's width — should key off the
 * `data-authed` flag in CSS instead (see AuthLabel and lib/auth-flag.ts).
 * This hook is for behaviour that runs after hydration anyway: analytics,
 * the mobile menu, the sticky CTA.
 */
export function useIsAuthed(): boolean {
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    const authed = AUTH_COOKIE.test(document.cookie);
    setAuthed(authed);
    // Keep the pre-paint flag honest across soft navigations: the inline
    // script only runs on a full document load, so a client-side route change
    // after signing in or out would otherwise leave <html> stale.
    document.documentElement.toggleAttribute(AUTH_FLAG_ATTR, authed);
  }, []);
  return authed;
}

/**
 * A CTA label that reads "Dashboard" once the visitor is signed in.
 *
 * Both strings are in the DOM at all times and CSS shows exactly one, chosen
 * from the `data-authed` flag stamped on <html> before first paint. So the
 * markup is identical on the server and the client (no hydration mismatch),
 * the correct word is there on the first frame, and — unlike the previous
 * overlay-both-strings-in-a-grid approach — the button is only as wide as the
 * label it is actually showing. batch0's CLS stays a perfect 0 either way.
 */
export function AuthLabel({
  signedOut,
  signedIn = "Dashboard",
}: {
  signedOut: string;
  signedIn?: string;
}) {
  return (
    <>
      <span className="when-anon">{signedOut}</span>
      <span className="when-authed">{signedIn}</span>
    </>
  );
}
