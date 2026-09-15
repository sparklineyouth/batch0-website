import Link from "next/link";
import { Lock, MessageSquare, Pin, ShieldCheck } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import { closedLabel, type DiscussionStatus, type DiscussionVisibility } from "@/lib/discussions-access";

/**
 * A list of threads, each a link into the thread page. Server-renderable:
 * no state, no handlers. `base` is the thread-page prefix, so the same rows
 * serve /dashboard/discussions and /admin/discussions.
 */

export type ThreadRow = {
  id: string;
  title: string;
  body: string;
  authorName: string;
  /** Admin lists only. Never set from a student page. */
  authorEmail?: string;
  isStaff: boolean;
  visibility: DiscussionVisibility;
  status: DiscussionStatus;
  pinned: boolean;
  needsReply: boolean;
  cohortName: string | null;
  replyCount: number;
  lastActivityAt: string;
};

export function ThreadList({
  threads,
  base,
  emptyText,
  showCohort = false,
}: {
  threads: ThreadRow[];
  base: string;
  emptyText: string;
  /** Admin lists span cohorts, so say which one each row is from. */
  showCohort?: boolean;
}) {
  if (threads.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-8 text-center">
        <MessageSquare className="mx-auto h-5 w-5 text-ink-faint" />
        <p className="mt-2 text-sm text-ink-soft">{emptyText}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line border-y border-line">
      {threads.map((t) => (
        <li key={t.id}>
          <Link
            href={`${base}/${t.id}`}
            prefetch={false}
            className="press group -mx-2 flex items-start gap-3 rounded-lg px-2 py-3.5 hover:bg-wash"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {t.pinned && (
                  <Pin className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-label="Pinned" />
                )}
                <p className="min-w-0 truncate text-[15px] font-medium text-ink group-hover:underline">
                  {t.title}
                </p>
                {t.visibility === "admin" && t.needsReply && (
                  <span className="rounded-full bg-phosphor/15 px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider text-phosphor-ink">
                    Awaiting reply
                  </span>
                )}
                {t.status === "closed" && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ink-faint">
                    <Lock className="h-3 w-3" />
                    {closedLabel(t.visibility)}
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-1 text-sm text-ink-soft">{t.body}</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
                <span className={t.isStaff ? "text-phosphor-ink" : undefined}>
                  {t.isStaff && <ShieldCheck className="mr-1 inline h-3 w-3" />}
                  {t.authorName}
                  {t.authorEmail ? ` · ${t.authorEmail}` : ""}
                </span>
                {showCohort && t.cohortName && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{t.cohortName}</span>
                  </>
                )}
                <span aria-hidden>·</span>
                <LocalTime value={t.lastActivityAt} mode="datetime-short" />
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1 pt-0.5 text-xs tabular-nums text-ink-faint">
              <MessageSquare className="h-3.5 w-3.5" />
              {t.replyCount}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
