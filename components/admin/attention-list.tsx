import Link from "next/link";
import { CalendarClock, CircleHelp, ClipboardCheck, Flag, LifeBuoy, type LucideIcon } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import {
  attentionEmptyText,
  ownerLabel,
  type AttentionResult,
  type AttentionSourceKey,
  type AttentionUrgency,
} from "@/lib/attention";

const SOURCE_ICON: Record<AttentionSourceKey, LucideIcon> = {
  support: LifeBuoy,
  feedback: ClipboardCheck,
  chat_reports: Flag,
  chat_questions: CircleHelp,
  followups: CalendarClock,
};

const SOURCE_NAME: Record<AttentionSourceKey, string> = {
  support: "Support",
  feedback: "Feedback",
  chat_reports: "Chat reports",
  chat_questions: "Unanswered questions",
  followups: "Follow-ups",
};

const REASON_TONE: Record<AttentionUrgency, string> = {
  overdue: "text-red-700 dark:text-red-300",
  due: "text-amber-700 dark:text-amber-300",
  waiting: "text-ink",
};

/**
 * The Overview's attention list (lib/attention.ts): a few rows of work
 * waiting on the team, each opening its source record. Server-rendered from
 * what the page already read; it has no state and does nothing on view.
 *
 * Ages are worked out on the server against one clock and handed down as
 * words, like the Support queue's reply-target cues, so nothing re-renders
 * differently in the browser.
 */
export function AttentionList({ attention }: { attention: AttentionResult }) {
  const { sources, rows, failed } = attention;
  if (sources.length === 0 && failed.length === 0) return null;
  const notes = sources.flatMap((s) => (s.note ? [{ key: s.key, ...s.note }] : []));
  const empty = attentionEmptyText(attention);

  return (
    <section aria-labelledby="attention-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="attention-heading" className="font-mono text-xs uppercase tracking-wider text-ink-faint">
          Needs attention
        </h2>
        {sources.length > 0 && (
          <nav aria-label="Every list" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {sources.map((s) => (
              <Link key={s.key} href={s.href} prefetch={false} className="text-ink-soft hover:text-ink">
                {s.label}{" "}
                <span className={`tabular-nums ${s.total > 0 ? "font-medium text-phosphor-ink" : "text-ink-faint"}`}>
                  {s.total.toLocaleString("en-US")}
                </span>
              </Link>
            ))}
          </nav>
        )}
      </div>

      {rows.length === 0 ? (
        empty && <p className="mt-3 border-y border-line py-6 text-center text-sm text-ink-soft">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {rows.map((r) => {
            const Icon = SOURCE_ICON[r.source];
            const owner = ownerLabel(r.owner);
            return (
              <li key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <Icon className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                <div className="min-w-0 flex-1 basis-56">
                  <p className={`text-sm font-medium ${REASON_TONE[r.urgency]}`}>
                    <span className="sr-only">{SOURCE_NAME[r.source]}: </span>
                    {r.reason}
                  </p>
                  <p className="truncate text-xs text-ink-soft" title={r.context}>
                    {r.context}
                  </p>
                </div>
                {/* On a phone this drops under the reason, lined up with its
                    text, and the owner gives way (truncates) so the button
                    stays inside the gutter down to a 320px screen. */}
                <div className="flex w-full items-center gap-3 pl-8 sm:w-auto sm:gap-4 sm:pl-0">
                  <p className="min-w-0 flex-1 truncate text-xs sm:w-28 sm:flex-none" title={`Owner: ${owner}`}>
                    <span className="sr-only">Owner: </span>
                    <span className={r.owner.kind === "nobody" ? "text-amber-700 dark:text-amber-300" : "text-ink-soft"}>
                      {owner}
                    </span>
                  </p>
                  <p className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-ink-faint sm:w-20">
                    <span className="sr-only">Waiting: </span>
                    {r.age}
                  </p>
                  <ButtonLink
                    href={r.action.href}
                    prefetch={false}
                    variant="secondary"
                    size="sm"
                    className="w-20 shrink-0"
                  >
                    {r.action.label}
                  </ButtonLink>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {notes.map((n) => (
        <p key={n.key} className="mt-2 text-xs text-ink-faint">
          <Link href={n.href} prefetch={false} className="hover:text-ink">
            {n.text}
          </Link>
        </p>
      ))}
      {failed.length > 0 && (
        <p role="status" className="mt-2 text-xs text-red-600 dark:text-red-400">
          Couldn&apos;t load {failed.map((k) => SOURCE_NAME[k]).join(", ")} just now. Their own pages have the full list.
        </p>
      )}
    </section>
  );
}
