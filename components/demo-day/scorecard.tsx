import type { Scorecard } from "@/lib/demo-day-rubric";
import { formatScore } from "@/lib/demo-day-rubric";

/**
 * One team's rubric scorecard, rendered the same way wherever it appears:
 * the admin's preview before release, and the founders' own copy after it.
 *
 * Sharing the component is the point. The release screen's job is to let an
 * admin decide whether a card is fair to hand over, and they can only do
 * that if what they're looking at is literally what the team will see —
 * including whether the judge notes are in it.
 */
export function RubricScorecard({
  card,
  showComments,
  className,
}: {
  card: Scorecard;
  showComments: boolean;
  className?: string;
}) {
  const scored = card.rows.filter((r) => r.average != null);

  if (scored.length === 0) {
    return (
      <p className={`text-sm text-ink-faint ${className ?? ""}`}>
        No judge has scored this team yet.
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Weighted score
          </div>
          <div className="font-display text-3xl font-bold tracking-[-0.02em] text-phosphor-ink tabular-nums">
            {card.weightedPct != null
              ? `${card.weightedPct.toFixed(1)}%`
              : "—"}
          </div>
        </div>
        <p className="text-xs text-ink-faint">
          {card.judgeCount} judge{card.judgeCount === 1 ? "" : "s"} ·{" "}
          {scored.length} of {card.rows.length} criteria scored
        </p>
      </div>

      <ul className="divide-y divide-line">
        {card.rows.map((r) => (
          <li key={r.criterion.id} className="py-4">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink">
                  {r.criterion.label}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-faint tabular-nums">
                  {Math.round(r.weightPct)}% of the score
                  {r.judgeCount > 0
                    ? ` · ${r.judgeCount} score${r.judgeCount === 1 ? "" : "s"}`
                    : ""}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <span className="font-display text-lg font-bold tracking-[-0.02em] text-ink tabular-nums">
                  {formatScore(r.average, r.maxScore)}
                </span>
              </div>
            </div>

            {r.average == null ? (
              <p className="mt-2 text-xs text-ink-faint">Not scored.</p>
            ) : (
              <>
                {/* The bar is the only place the shape of a card is readable
                    at a glance; the number next to it is what gets quoted. */}
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-wash">
                  <div
                    className="h-full rounded-full bg-phosphor"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          (r.average / Math.max(r.maxScore, 1)) * 100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                {r.anchor && (
                  <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                    {r.anchor}
                  </p>
                )}
                {showComments && r.comments.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {r.comments.map((c, i) => (
                      <li
                        key={i}
                        className="border-l-2 border-phosphor/50 pl-3 text-xs leading-relaxed text-ink-soft"
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
