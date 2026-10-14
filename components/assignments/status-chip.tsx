import { statusLabel, statusTone, type DerivedStatus } from "@/lib/assignments";

const TONES = {
  accent: "bg-phosphor/15 text-phosphor-ink",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300",
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  muted: "bg-wash text-ink-faint border border-line",
} as const;

/** One assignment status, as a chip. "staff" says Missing where students read Late. */
export function StatusChip({
  status,
  audience = "student",
  className = "",
}: {
  status: DerivedStatus;
  audience?: "student" | "staff";
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ${TONES[statusTone(status)]} ${className}`}
    >
      {statusLabel(status, audience)}
    </span>
  );
}
