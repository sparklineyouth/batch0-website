import { Ticket } from "lucide-react";

/**
 * Inline mark for founder-pass holders, shown next to their name wherever
 * people appear in the community: public team pages, cohort team pages, and
 * team conversation threads.
 *
 * One component rather than per-surface markup so the mark reads identically
 * everywhere — it's a status symbol, and status symbols only work when they're
 * recognisable. Colors are the phosphor pair, which the `.theme-light`
 * overrides in globals.css already remap for light product surfaces, so this
 * renders correctly on the dark community pages and the theme-reactive
 * dashboard alike.
 *
 * Holder sets come from passHolderUserIds() (lib/founder-pass.ts) — one query
 * per page, no N+1, same pattern the admin review queue uses for its badge.
 */
export function FounderPassBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="Holds a batch0 founder pass"
      className={`inline-flex items-center gap-1 rounded-full bg-phosphor/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wider text-phosphor ${className}`}
    >
      <Ticket className="h-3 w-3" />
      founder pass
    </span>
  );
}
