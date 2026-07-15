"use client";
import { track } from "@vercel/analytics";

/**
 * The one conversion action, with one name everywhere: "Apply for Cohort N".
 * Client component so every instance fires the same analytics event; the
 * form-submit end of the funnel fires "application_submitted" in
 * app/apply/application-form.tsx.
 */
export function ApplyCta({
  href = "/apply",
  label,
  location,
  variant = "primary",
  className = "",
}: {
  href?: string;
  label: string;
  /** Where on the page this CTA lives — e.g. "hero", "final-cta", "navbar". */
  location: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  // Squared corners + key-press shift: buttons press like keys (the
  // broadsheet system) — no soft shadows, no radius.
  const base =
    "press inline-flex items-center justify-center gap-2 text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
  const variants = {
    primary: "bg-phosphor px-5 py-3.5 text-on-phosphor hover:bg-phosphor-200",
    secondary:
      "border border-line bg-paper px-5 py-3.5 font-medium text-ink hover:border-ink/30",
  } as const;
  return (
    <a
      href={href}
      className={`${base} ${variants[variant]} ${className}`}
      onClick={() => track("apply_click", { location })}
    >
      {label}
    </a>
  );
}
