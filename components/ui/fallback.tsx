import * as React from "react";

/**
 * The shared shape of every degraded screen on the site — 404s, error
 * boundaries, and the "this integration is off" states that render in place of
 * a feature.
 *
 * There is one component rather than a copy per boundary because the failure
 * screens are the surfaces least likely to be looked at again after they ship.
 * Left to drift they end up the only pages on the site that don't look like the
 * site, which is exactly the impression a failure should not also make.
 *
 * Everything here is token-only (`ink` / `ink-soft` / `line` / `wash`), never
 * literal `text-white` or `bg-black`. Those literals do survive light mode via
 * the `.theme-light` compat layer in globals.css, but only for the handful of
 * alphas that layer enumerates — and a fallback screen is the one place where
 * "mostly readable" isn't good enough, because by definition the user is
 * already stuck. Tokens flip correctly in every theme with no list to maintain.
 *
 * `variant` controls the vertical bearing, not the palette:
 *   "page"    — owns the viewport. Root 404 / root error, where no product
 *               chrome survived and the screen has to stand on its own.
 *   "inline"  — renders inside a layout that is still intact (the dashboard,
 *               admin, mentor, investor and installed-app shells all keep their
 *               sidebar when a nested boundary catches). Sits in the content
 *               column at the same rhythm as a real page instead of shoving the
 *               chrome around.
 */
export function Fallback({
  eyebrow,
  title,
  body,
  icon,
  reference,
  actions,
  variant = "page",
}: {
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  icon?: React.ReactNode;
  /** Sentry digest or similar. Rendered only when present. */
  reference?: string | null;
  actions?: React.ReactNode;
  variant?: "page" | "inline";
}) {
  return (
    <div
      className={
        variant === "page"
          ? "flex min-h-[70vh] flex-col items-center justify-center px-6 py-24 text-center"
          : // px-6 is not redundant with the product layouts' own gutters: the
            // installed app's <main> (components/app/frame.tsx) has none, so an
            // inline fallback there would run to the edge of a 390px screen.
            "mx-auto max-w-md px-6 py-16 text-center"
      }
    >
      {icon && (
        <div className="mb-6 flex justify-center text-ink-faint">{icon}</div>
      )}
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
        {eyebrow}
      </p>
      <h1 className="mt-3 font-display text-3xl tracking-[-0.02em] text-ink md:text-4xl">
        {title}
      </h1>
      <div className="mx-auto mt-4 max-w-sm text-[15px] leading-relaxed text-ink-soft">
        {body}
      </div>
      {reference && (
        <p className="mx-auto mt-5 max-w-sm break-all rounded-md border border-line bg-wash px-3 py-2 font-mono text-[11px] text-ink-faint">
          Reference: <span className="text-ink-soft">{reference}</span>
        </p>
      )}
      {actions && (
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {actions}
        </div>
      )}
    </div>
  );
}
