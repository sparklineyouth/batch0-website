"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * The last boundary before global-error.
 *
 * It only catches what no nested boundary did — the marketing routes, the auth
 * funnel, and anything that fails inside a *layout* (a layout's own error is
 * caught by the boundary one level up, which is why the product segments have
 * boundaries and this one still has to look right on a signed-in surface).
 *
 * This used to be written in literal `text-white/70` / `border-white/15`. Those
 * do get remapped for light mode by the `.theme-light` compat layer in
 * globals.css, but only because someone remembered to enumerate those exact
 * alphas there — a screen whose entire job is to be readable when something
 * else has already failed shouldn't depend on that. ErrorScreen is token-only.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} />;
}
