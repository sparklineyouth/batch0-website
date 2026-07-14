import Link from "next/link";
import { Lock, ArrowRight } from "lucide-react";
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
  /** Feature name, e.g. "Team", "Course", "Check-ins". */
  title: string;
  applicationStatus: ApplicationStatus | null;
}) {
  const { lede, cta } = copyFor(applicationStatus);
  return (
    <div className="mx-auto max-w-2xl">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
        {title} · locked
      </p>
      <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-[-0.02em] text-ink">
        {title} unlocks at enrollment.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">{lede}</p>
      <div className="mt-7 flex items-center gap-3">
        {cta && (
          <Link
            href={cta.href}
            className="press inline-flex items-center gap-2 rounded-md bg-phosphor px-4 py-2.5 text-sm font-semibold text-on-phosphor hover:bg-phosphor-200"
          >
            {cta.label}
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
        <Link
          href="/dashboard"
          className="press inline-flex items-center gap-2 rounded-md border border-line px-4 py-2.5 text-sm font-medium text-ink-soft hover:border-ink/30 hover:bg-wash"
        >
          Back to dashboard
        </Link>
      </div>
      <div className="mt-10 flex items-start gap-3 rounded-xl border border-line bg-wash px-5 py-4 text-sm text-ink-soft">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
        <p>
          Cohort-only features (Team, Check-in, Course, Office hours, Events,
          Resources, Files) unlock once you're enrolled. You'll see them in
          the sidebar then.
        </p>
      </div>
    </div>
  );
}

function copyFor(status: ApplicationStatus | null) {
  switch (status) {
    case null:
    case undefined:
      return {
        lede:
          "Apply to claim a seat. Acceptance unlocks the team workspace, weekly check-ins, and live cohort events.",
        cta: { href: "/apply", label: "Start application" },
      };
    case "draft":
      return {
        lede:
          "Your application is still a draft. Finish and submit it to start review.",
        cta: { href: "/apply", label: "Finish application" },
      };
    case "submitted":
      return {
        lede:
          "Your application is in review. We'll email you when there's a decision; cohort features unlock once you're enrolled.",
        cta: null,
      };
    case "accepted":
      return {
        lede:
          "You're accepted — lock in your seat with the one-time tuition and the cohort features come online immediately.",
        cta: { href: "/dashboard/application", label: "Pay to enroll" },
      };
    case "rejected":
      return {
        lede:
          "You weren't selected for this cohort. You can apply again to a different one.",
        cta: { href: "/apply", label: "Apply to another cohort" },
      };
    case "withdrawn":
      return {
        lede:
          "You withdrew from a previous application. Reapply when you're ready to claim a seat.",
        cta: { href: "/apply", label: "Reapply" },
      };
    default:
      return {
        lede:
          "Cohort features unlock once you're enrolled. Apply or finish your application to get there.",
        cta: { href: "/apply", label: "Open application" },
      };
  }
}
