"use client";
import { track } from "@vercel/analytics";
import { AuthLabel } from "@/components/auth-label";

/**
 * The one conversion action, with one name everywhere: "Apply for Cohort N".
 * Client component so every instance fires the same analytics event; the
 * form-submit end of the funnel fires "application_submitted" in
 * app/apply/application-form.tsx.
 */
export function ApplyCta({
  // /home, not /apply: middleware resolves it at the edge in one hop —
  // signed-in visitors land on their own panel, everyone else on /apply.
  // Defaulting here (rather than at each call site) is what stops one page
  // from offering "Go to dashboard" up top and a dead-end "Apply" at the
  // bottom. It stays a constant href, so callers stay prerenderable.
  href = "/home",
  label,
  signedInLabel = "Go to dashboard",
  location,
  variant = "primary",
  className = "",
}: {
  href?: string;
  label: string;
  /**
   * Shown instead of `label` once the browser confirms a session. Defaults on
   * so no CTA can promise "Apply" to someone who already has an account. Only
   * override `href` with an auth-neutral path — the point is to keep the page
   * prerenderable, so the href must be right before hydration.
   */
  signedInLabel?: string;
  /** Where on the page this CTA lives — e.g. "hero", "final-cta", "navbar". */
  location: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const base =
    "press inline-flex items-center justify-center gap-2 rounded-md text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
  const variants = {
    primary: "bg-yellow-200 px-5 py-3.5 text-on-phosphor shadow-cta hover:bg-phosphor-200",
    secondary:
      "border border-line bg-paper px-5 py-3.5 font-medium text-ink hover:border-ink/30",
  } as const;
  return (
    <a
      href={href}
      className={`${base} ${variants[variant]} ${className}`}
      onClick={() => track("apply_click", { location })}
    >
      {signedInLabel ? (
        <AuthLabel signedOut={label} signedIn={signedInLabel} />
      ) : (
        label
      )}
    </a>
  );
}
