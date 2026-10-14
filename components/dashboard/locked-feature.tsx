import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ApplicationStatus } from "@/lib/types";

/**
 * Soft block for routes that should only be reachable once a student
 * is enrolled in a cohort. The status copy is derived from where the
 * applicant is in the lifecycle so the message reflects reality (not
 * generic "you don't have access").
 */
export function LockedFeature({
  title,
  applicationStatus,
}: {
  /** Feature name, e.g. "Team", "Course", "Assignments". */
  title: string;
  applicationStatus: ApplicationStatus | null;
}) {
  const { lede, cta } = lockedCopy(applicationStatus);
  return (
    <div className="mx-auto max-w-2xl">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
        Locked
      </p>
      <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-[-0.02em] text-ink">
        {title} unlocks at enrollment.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">{lede}</p>
      {/* whitespace-nowrap as well as flex-wrap: the links are still
          shrinkable, so without it they squeeze onto one 375px row and
          break their own labels mid-phrase instead of wrapping. */}
      <div className="mt-7 flex flex-wrap items-center gap-3">
        {cta && (
          <Link
            href={cta.href}
            className="press inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-phosphor px-4 py-2.5 text-sm font-semibold text-on-phosphor hover:bg-phosphor-200"
          >
            {cta.label}
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
        <Link
          href="/dashboard"
          className="press inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-line px-4 py-2.5 text-sm font-medium text-ink-soft hover:border-ink/30 hover:bg-wash"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

/**
 * What a locked page says, by where the applicant stands. Shared with the
 * installed app's locked screens (components/app/locked-alert.tsx): only an
 * accepted applicant has a seat to pay for.
 */
export function lockedCopy(status: ApplicationStatus | null): {
  lede: string;
  cta: { href: string; label: string } | null;
} {
  switch (status) {
    case null:
    case undefined:
      return { lede: "Apply to claim a seat.", cta: { href: "/apply", label: "Start application" } };
    case "draft":
      return { lede: "Your application is a draft.", cta: { href: "/apply", label: "Finish application" } };
    case "submitted":
      return { lede: "Your application is in review.", cta: null };
    case "accepted":
      return { lede: "You're accepted.", cta: { href: "/dashboard/accepted", label: "Pay to enroll" } };
    case "waitlisted":
      return { lede: "You're waitlisted. We'll email you.", cta: null };
    case "rejected":
      return { lede: "Not this cohort.", cta: { href: "/apply", label: "Apply to another cohort" } };
    case "withdrawn":
      return { lede: "You withdrew your application.", cta: { href: "/apply", label: "Reapply" } };
    default:
      return { lede: "Opens once you're enrolled.", cta: { href: "/apply", label: "Open application" } };
  }
}
