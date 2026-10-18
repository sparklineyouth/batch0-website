"use client";
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import {
  EDITOR_LABEL,
  readinessSummary,
  type CheckState,
  type CohortReadiness,
  type ReadinessLink,
} from "@/lib/cohort-readiness";

// Same tones as the assignment status chips, so "bad" reads the same everywhere.
const CHIP: Record<CheckState, string> = {
  pass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  fail: "bg-red-500/15 text-red-700 dark:text-red-300",
};

const ICON: Record<CheckState, { Icon: typeof CheckCircle2; className: string; label: string }> = {
  pass: { Icon: CheckCircle2, className: "text-emerald-700 dark:text-emerald-300", label: "Pass" },
  warn: { Icon: AlertTriangle, className: "text-amber-700 dark:text-amber-300", label: "Check" },
  fail: { Icon: XCircle, className: "text-red-700 dark:text-red-300", label: "Fix" },
};

// Enough to see the shape of a problem; the rest stay one click away.
const ITEMS_SHOWN = 5;

/** The cohort row's summary chip, which opens and closes its checklist. */
export function ReadinessToggle({
  readiness,
  open,
  onToggle,
  controls,
}: {
  readiness: CohortReadiness;
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const s = readinessSummary(readiness);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ${CHIP[s.tone]}`}
    >
      {s.label}
      <Chevron className="h-3 w-3" aria-hidden />
      <span className="sr-only">{open ? "Hide" : "Show"} readiness checklist</span>
    </button>
  );
}

/**
 * The checklist itself. `onEditCohort` opens the cohort form on this page;
 * every other link goes to the screen that owns the data.
 */
export function ReadinessChecklist({
  id,
  readiness,
  onEditCohort,
}: {
  id: string;
  readiness: CohortReadiness;
  onEditCohort: () => void;
}) {
  return (
    <ul id={id} className="divide-y divide-line border-y border-line">
      {readiness.checks.map((c) => {
        const { Icon, className, label } = ICON[c.state];
        return (
          <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">
                <span className="sr-only">{label}: </span>
                <span className="font-medium">{c.label}</span>
                <span className="text-ink-soft"> · {c.detail}</span>
              </p>
              {c.items.length > 0 && <Items items={c.items} onEditCohort={onEditCohort} />}
            </div>
            {c.fix && (
              <FixLink link={c.fix} onEditCohort={onEditCohort} className="text-xs text-phosphor-ink hover:underline">
                {EDITOR_LABEL[c.fix.editor]} →
              </FixLink>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Items({
  items,
  onEditCohort,
}: {
  items: CohortReadiness["checks"][number]["items"];
  onEditCohort: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, ITEMS_SHOWN);
  const hidden = items.length - shown.length;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
      {shown.map((item, i) => (
        <li key={i}>
          {item.link ? (
            <FixLink link={item.link} onEditCohort={onEditCohort} className="hover:text-ink hover:underline">
              {item.text}
            </FixLink>
          ) : (
            item.text
          )}
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button type="button" onClick={() => setAll(true)} className="text-ink-faint hover:text-ink">
            {hidden} more
          </button>
        </li>
      )}
    </ul>
  );
}

/** The cohort's own fields are edited in place on this page; anything else is a link. */
function FixLink({
  link,
  onEditCohort,
  className,
  children,
}: {
  link: ReadinessLink;
  onEditCohort: () => void;
  className: string;
  children: React.ReactNode;
}) {
  if (link.editor === "cohort") {
    return (
      <button type="button" onClick={onEditCohort} className={`text-left ${className}`}>
        {children}
      </button>
    );
  }
  return (
    <Link href={link.href} className={className}>
      {children}
    </Link>
  );
}
