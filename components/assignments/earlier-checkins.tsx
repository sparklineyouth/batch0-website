import type { ReactNode } from "react";
import { LocalTime } from "@/components/ui/local-time";
import { weekOfLabel, type CheckinHistoryItem } from "@/lib/checkin-history";

/**
 * Read-only weekly check-ins from before the assignment tracker, with the
 * feedback on them, collapsed. Renders nothing for someone who never posted
 * one.
 */
export function EarlierCheckins({
  items,
  className = "",
}: {
  items: CheckinHistoryItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <details className={`group rounded-xl border border-line bg-paper ${className}`}>
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink">
        Earlier check-ins ({items.length})
      </summary>
      <ul className="divide-y divide-line border-t border-line">
        {items.map((c) => (
          <li key={c.id} className="px-4 py-3 text-sm">
            <p className="font-mono text-xs uppercase tracking-wider text-ink-faint">
              {weekOfLabel(c.weekStart)}
            </p>
            <dl className="mt-1.5 space-y-1">
              {c.accomplished && <Line label="Did">{c.accomplished}</Line>}
              {c.nextUp && <Line label="Next">{c.nextUp}</Line>}
              {c.blockers && <Line label="Blockers">{c.blockers}</Line>}
            </dl>
            {c.feedback.length > 0 && (
              <ul className="mt-2 space-y-1.5 border-l-2 border-phosphor/40 pl-3">
                {c.feedback.map((f) => (
                  <li key={f.id} className="text-ink-soft">
                    <span className="font-medium text-ink">{f.author}</span>
                    <span className="text-xs text-ink-faint">
                      {" "}
                      · <LocalTime value={f.at} mode="date" />
                    </span>
                    <p className="whitespace-pre-wrap break-words">{f.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-xs text-ink-faint">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-ink-soft">{children}</dd>
    </div>
  );
}
