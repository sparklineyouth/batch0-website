import Link from "next/link";
import { Flag, ShieldCheck } from "lucide-react";
import { formatRelativeTime } from "@/lib/format-time";
import { getConversationRow, getPeople, listReports } from "@/lib/dm";
import type { ReportStatus } from "@/lib/dm-access";

export const metadata = { title: "Reported DMs · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type View = ReportStatus | "all";

/**
 * Reported direct messages. Gated by `moderation.manage`
 * (app/admin/layout.tsx + the route rule in lib/permissions.ts).
 *
 * This page is the whole staff window into DMs. There is no "browse all
 * conversations" view and there shouldn't be: a DM nobody reported is not
 * readable by anyone here, which is what the product promises users at the
 * moment they press Report.
 */
export default async function AdminMessagesPage(props: {
  searchParams?: Promise<{ view?: string }>;
}) {
  const searchParams = await props.searchParams;
  const view: View =
    searchParams?.view === "actioned"
      ? "actioned"
      : searchParams?.view === "dismissed"
        ? "dismissed"
        : searchParams?.view === "all"
          ? "all"
          : "open";

  const [reports, open] = await Promise.all([
    listReports(view),
    listReports("open", 500),
  ]);

  // Who the reported conversations are between — a queue that only showed
  // "a conversation" would make a moderator open every row to triage.
  const convos = await Promise.all(
    Array.from(new Set(reports.map((r) => r.conversationId))).map(async (id) => ({
      id,
      row: await getConversationRow(id),
    })),
  );
  const participantIds = convos.flatMap((c) =>
    c.row ? [c.row.userA, c.row.userB] : [],
  );
  const people = await getPeople(Array.from(new Set(participantIds)));
  const pairFor = (conversationId: string) => {
    const row = convos.find((c) => c.id === conversationId)?.row;
    if (!row) return "Conversation deleted";
    const a = people.get(row.userA)?.name ?? "Deleted account";
    const b = people.get(row.userB)?.name ?? "Deleted account";
    return `${a} ↔ ${b}`;
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Reported DMs
          </h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Direct messages are private. A report is the only thing that opens
            one to the team — and only that one conversation.
          </p>
        </div>
      </div>

      <nav className="mt-8 flex gap-1 border-b border-line" aria-label="Report views">
        <TabLink href="/admin/messages" active={view === "open"}>
          Open
          {open.length > 0 && (
            <span className="ml-1.5 rounded-full bg-phosphor/15 px-1.5 text-[10px] text-phosphor-ink">
              {open.length}
            </span>
          )}
        </TabLink>
        <TabLink href="/admin/messages?view=actioned" active={view === "actioned"}>
          Actioned
        </TabLink>
        <TabLink href="/admin/messages?view=dismissed" active={view === "dismissed"}>
          Dismissed
        </TabLink>
        <TabLink href="/admin/messages?view=all" active={view === "all"}>
          All
        </TabLink>
      </nav>

      <section className="mt-5">
        {reports.length === 0 ? (
          <div className="rounded-2xl border border-line bg-wash px-6 py-14 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-line">
              <ShieldCheck className="h-4 w-4 text-ink-faint" />
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              {view === "open" ? "Nothing to review." : "Nothing here."}
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              Reports land here the moment someone files one.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {reports.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/admin/messages/${r.conversationId}`}
                  prefetch={false}
                  className="press block px-4 py-3.5 hover:bg-wash"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                        <Flag className="h-3 w-3 shrink-0 text-red-400" />
                        <span className="truncate">{pairFor(r.conversationId)}</span>
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-ink-soft">
                        {r.reason}
                      </p>
                      <p className="mt-1 text-[11px] text-ink-faint">
                        Reported by {r.reporterName}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <StatusBadge status={r.status} />
                      <p className="mt-1 text-[10px] font-mono tabular-nums text-ink-faint">
                        {formatRelativeTime(r.createdAt)}
                      </p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: ReportStatus }) {
  const style =
    status === "open"
      ? "bg-red-500/15 text-red-300"
      : status === "actioned"
        ? "bg-phosphor/15 text-phosphor-ink"
        : "border border-line text-ink-faint";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${style}`}>
      {status}
    </span>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={`-mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm ${
        active
          ? "border-phosphor font-medium text-ink"
          : "border-transparent text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
