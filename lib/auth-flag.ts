/**
 * The signed-in flag, resolved before first paint.
 *
 * Marketing pages are prerendered static HTML, so the server cannot know
 * whether the visitor has a session — reading cookies would opt every one of
 * them out of prerendering. The flag is therefore stamped on <html> by a
 * blocking inline script (see app/layout.tsx), the same trick next-themes uses
 * for `data-theme`: it runs during parse, before anything paints, so CSS can
 * size and lay out auth-dependent chrome correctly on the *first* frame.
 *
 * That matters because the alternative — swapping the label after hydration —
 * either shifts the layout or, if you reserve space for the longer string,
 * leaves a "Dashboard" button stretched to the width of "Apply for Cohort 1".
 */

/**
 * The session cookie @supabase/ssr writes: `sb-<projectRef>-auth-token`, split
 * into `.0` / `.1` when it outgrows the cookie size limit. Its
 * DEFAULT_COOKIE_OPTIONS set `httpOnly: false`, so the document can see it.
 *
 * Presence, not validity: an expired-but-present cookie reads as signed in.
 * That is safe because the flag only chooses a *word* — every auth-aware CTA
 * points at the constant /home, which resolves the real destination
 * server-side either way.
 */
export const AUTH_COOKIE = /(?:^|;\s*)sb-[^=;]*-auth-token(?:\.\d+)?=/;

/** The attribute the script sets on <html>; `.when-authed` / `.when-anon` in
 * globals.css key off it. */
export const AUTH_FLAG_ATTR = "data-authed";

/**
 * Body of the pre-paint script. A fixed literal — the regex is interpolated
 * from AUTH_COOKIE above so the two can never drift — so it is safe to inject.
 */
export const AUTH_FLAG_SCRIPT =
  `try{if(${String(AUTH_COOKIE)}.test(document.cookie))` +
  `document.documentElement.setAttribute("${AUTH_FLAG_ATTR}","")}catch(e){}`;
