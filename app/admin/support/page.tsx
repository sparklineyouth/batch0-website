import Link from "next/link";
import {
  AlarmClock,
  ChevronLeft,
  ChevronRight,
  Flame,
  Hourglass,
  LifeBuoy,
  Plus,
  SearchX,
  UserCheck,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { isMissingTable } from "@/lib/email/store";
import {
  SUPPORT_PAGE_SIZE,
  countTicketsForStaff,
  listTicketsForStaff,
  type SupportCounts,
} from "@/lib/support";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  SEARCH_QUERY_MAX,
  SLA_TARGET_HOURS,
  STAFF_TICKET_VIEWS,
  STAFF_VIEW_LABELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  isSensitiveCategory,
  parseCategory,
  supportScopeFor,
  toPriority,
  toStaffAssigneeFilter,
  toStaffTicketView,
  type StaffAssigneeFilter,
  type StaffTicketView,
  type TicketCategory,
  type TicketPriority,
} from "@/lib/support-access";
import { slaCue } from "./badges";
import { SupportSearch } from "./support-search";
import {
  SupportTicketTable,
  type SupportTicketRow,
} from "./ticket-table";

export const metadata = { title: "Support · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Everything the queue's URL can say. Every link on this page is built from
 * one of these, so clicking any filter keeps all the others:
 *
 *   ?view=      needs_reply (the default, never written) · waiting_on_requester
 *               · resolved · closed · all
 *   ?category=  a category key
 *   ?priority=  urgent · high · normal · low
 *   ?assignee=  mine · unassigned (anyone is the default, never written)
 *   ?q=         the search
 *   ?page=      1-based
 */
type QueueState = {
  view: StaffTicketView;
  category: TicketCategory | null;
  priority: TicketPriority | null;
  assignee: StaffAssigneeFilter;
  q: string;
  page: number;
};

type RawSearchParams = Record<string, string | string[] | undefined>;

/** A repeated param arrives as an array; the first one wins. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readQueueState(sp: RawSearchParams): QueueState {
  const page = Number(first(sp.page) ?? "1");
  return {
    // Anything toStaffTicketView doesn't know is the work queue — which is
    // also what keeps the old ?view=queue and ?view=open links working: both
    // meant "needs reply" before the views were named after the data layer's.
    view: toStaffTicketView(first(sp.view)),
    // A category or priority we don't know is no filter at all, not a guess.
    category: parseCategory(first(sp.category)),
    priority: toPriority(first(sp.priority)),
    assignee: toStaffAssigneeFilter(first(sp.assignee)),
    // Trimmed after the cut too: the search box compares its own trimmed
    // text with this to tell its echo from a change made elsewhere.
    q: (first(sp.q) ?? "").trim().slice(0, SEARCH_QUERY_MAX).trim(),
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/** The params for a state, defaults left out so the plain queue stays /admin/support. */
function queueParams(s: QueueState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.view !== "needs_reply") p.set("view", s.view);
  if (s.category) p.set("category", s.category);
  if (s.priority) p.set("priority", s.priority);
  if (s.assignee !== "anyone") p.set("assignee", s.assignee);
  if (s.q) p.set("q", s.q);
  if (s.page > 1) p.set("page", String(s.page));
  return p;
}

function queueHref(s: QueueState): string {
  const qs = queueParams(s).toString();
  return qs ? `/admin/support?${qs}` : "/admin/support";
}

const PRIORITY_FILTERS: { value: TicketPriority | null; label: string }[] = [
  { value: null, label: "Any" },
  ...TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })),
];

const OWNER_FILTERS: { value: StaffAssigneeFilter; label: string }[] = [
  { value: "anyone", label: "Anyone" },
  { value: "mine", label: "Mine" },
  { value: "unassigned", label: "Unassigned" },
];

/**
 * The chip tones of the email metrics page (app/admin/email/metric-ui.tsx),
 * so a warning reads the same everywhere in the panel.
 */
const ATTENTION_TONE = {
  bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  default: "border-line bg-wash text-ink-soft",
} as const;

type Attention = {
  key: string;
  label: string;
  href: string;
  tone: keyof typeof ATTENTION_TONE;
  icon: LucideIcon;
};

/**
 * What needs someone, as links into the slice of the queue that shows it.
 * Every number is among needs-reply requests and under the page's own
 * filters, so "2 overdue" next to "Refund request" means two overdue refunds.
 *
 * Overdue and due-soon have no filter of their own and don't need one: the
 * needs-reply view is sorted by due time, so they are its top rows. A chip
 * whose filter is already on is left out — it would only repeat the tab.
 */
function attentionFor(
  counts: SupportCounts,
  state: QueueState,
  href: (patch: Partial<QueueState>) => string,
): Attention[] {
  if (!counts.available) return [];
  const work = (patch: Partial<QueueState> = {}) => href({ view: "needs_reply", ...patch });
  const out: Attention[] = [];
  if (counts.overdue > 0) {
    out.push({
      key: "overdue",
      label: `${counts.overdue} overdue`,
      href: work(),
      tone: "bad",
      icon: AlarmClock,
    });
  }
  if (counts.dueSoon > 0) {
    out.push({
      key: "due",
      label: `${counts.dueSoon} due soon`,
      href: work(),
      tone: "warn",
      icon: Hourglass,
    });
  }
  if (counts.urgent > 0 && state.priority !== "urgent") {
    out.push({
      key: "urgent",
      label: `${counts.urgent} urgent`,
      href: work({ priority: "urgent" }),
      tone: "bad",
      icon: Flame,
    });
  }
  if (counts.unassigned > 0 && state.assignee !== "unassigned") {
    out.push({
      key: "unassigned",
      label: `${counts.unassigned} unassigned`,
      href: work({ assignee: "unassigned" }),
      tone: "default",
      icon: UserX,
    });
  }
  if (counts.mine > 0 && state.assignee !== "mine") {
    out.push({
      key: "mine",
      label: `${counts.mine} assigned to you`,
      href: work({ assignee: "mine" }),
      tone: "default",
      icon: UserCheck,
    });
  }
  return out;
}

/**
 * The empty table, in terms of what's actually narrowing it — a search that
 * matched nothing gets a different answer, and a different way out, from a
 * queue that is genuinely clear.
 */
function emptyState(args: {
  state: QueueState;
  counts: SupportCounts;
  total: number;
  pageSize: number;
  /** The read failed: an empty list then says nothing about the queue. */
  failed: boolean;
  href: (patch: Partial<QueueState>) => string;
}): { text: string; links: { href: string; label: string }[] } {
  const { state, counts, total, pageSize, failed, href } = args;
  const filtered = !!(state.category || state.priority || state.assignee !== "anyone");
  const unfiltered = href({ category: null, priority: null, assignee: "anyone" });

  // Never "Inbox zero" over a query that didn't run. The reason is printed
  // under the table.
  if (failed) {
    return {
      text: "The queue couldn't be read just now.",
      links: [{ href: href({ page: state.page }), label: "Try again" }],
    };
  }

  // Rows exist, just not on this page: a stale ?page= after the queue shrank.
  if (total > 0) {
    const last = Math.max(1, Math.ceil(total / pageSize));
    if (state.page > last) {
      const n = total.toLocaleString("en-US");
      return {
        text: `There's no page ${state.page} — ${n} ${total === 1 ? "request matches" : "requests match"}.`,
        links: [
          { href: href({ page: last }), label: last === 1 ? "Back to the list" : `Go to page ${last}` },
        ],
      };
    }
    // Inside the range but empty: needs reply sorts only its longest-waiting
    // 500 by due time (lib/support.ts), and this page is past them.
    return {
      text:
        "This page is past the requests the queue sorts by due time. Narrow it with a filter or a search.",
      links: [{ href: href({}), label: "Back to page 1" }],
    };
  }

  if (state.q) {
    const where = state.view === "all" ? "" : ` in ${STAFF_VIEW_LABELS[state.view]}`;
    const links: { href: string; label: string }[] = [];
    // The common miss: searching the work queue for a request that's already
    // been answered. The counts carry the search, so they know where it is.
    if (state.view !== "all" && counts.available && counts.all > 0) {
      links.push({
        href: href({ view: "all" }),
        label: `${counts.all.toLocaleString("en-US")} in other views — search them all`,
      });
    }
    if (filtered) links.push({ href: unfiltered, label: "Clear the filters" });
    links.push({ href: href({ q: "" }), label: "Clear the search" });
    return { text: `No requests match “${state.q}”${where}.`, links };
  }

  if (filtered) {
    // The two an owner filter on the work queue is usually asking about.
    const ownerOnly = state.view === "needs_reply" && !state.category && !state.priority;
    const text =
      ownerOnly && state.assignee === "mine"
        ? "Nothing assigned to you needs a reply."
        : ownerOnly && state.assignee === "unassigned"
          ? "Every request that needs a reply has an owner."
          : "Nothing here matches these filters.";
    return { text, links: [{ href: unfiltered, label: "Clear the filters" }] };
  }

  const text: Record<StaffTicketView, string> = {
    needs_reply: "Inbox zero. Every request has a reply.",
    waiting_on_requester: "Nobody owes us an answer right now.",
    resolved: "No resolved requests.",
    closed: "No closed requests.",
    all: "No requests yet.",
  };
  return { text: text[state.view], links: [] };
}

/**
 * The team's support queue.
 *
 * Every filter in the URL goes to BOTH the list and the counts, so the
 * number on a tab is always the number of rows under it, and the attention
 * strip talks about the same slice the table shows. The scope carries the
 * confidentiality rule into the rows AND the counts: a confidential concern
 * is simply absent for anyone without support.sensitive, so nothing on this
 * page — not a tab, not "1 urgent" — can give one away.
 */
export default async function AdminSupportPage(props: {
  searchParams: Promise<RawSearchParams>;
}) {
  const [searchParams, viewer] = await Promise.all([
    props.searchParams,
    requirePermission("support.view"),
  ]);
  const state = readQueueState(searchParams);
  const scope = supportScopeFor(viewer.profile.id, viewer.caps);
  const canManage = can(viewer.caps, "support.manage");

  // One clock for the whole render: the strip's "3 overdue" and the rows'
  // "overdue 2h" must agree about what time it is.
  const now = Date.now();
  const filter = {
    category: state.category,
    priority: state.priority,
    assignee: state.assignee,
    search: state.q || null,
  };
  const [list, counts] = await Promise.all([
    listTicketsForStaff(
      { ...filter, view: state.view, page: state.page, pageSize: SUPPORT_PAGE_SIZE },
      scope,
    ),
    countTicketsForStaff(scope, filter, now),
  ]);
  const { tickets, total, page, pageSize, error } = list;

  if (error && isMissingTable(error)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl text-ink">
          Support
        </h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Run migration{" "}
            <code className="font-mono text-phosphor-ink">
              0090_support_tickets.sql
            </code>{" "}
            to create the queue.
          </p>
        </Card>
      </div>
    );
  }

  // Any change of filter lands on page 1 — page 3 of a different result set
  // is nobody's "where I was". Only the pager passes a page on.
  const href = (patch: Partial<QueueState>) => queueHref({ ...state, page: 1, ...patch });
  const here = queueHref({ ...state, page });

  const rows: SupportTicketRow[] = tickets.map((t) => ({
    id: t.id,
    reference: t.reference,
    subject: t.subject,
    category: t.category,
    status: t.status,
    // The email is the identity here — the account name may be missing and the
    // requester may no longer have a profile at all. Reading it is what
    // support.view is marked sensitive for.
    requesterLabel:
      t.requesterName?.trim() || t.accountName?.trim() || t.requesterEmail,
    priority: t.priority,
    sensitive: t.sensitive,
    owner: t.assignedTo
      ? {
          name: t.assignedName?.trim() || "Someone on the team",
          isViewer: t.assignedTo === viewer.profile.id,
        }
      : null,
    replyCount: t.replyCount,
    // Worked out here, against `now`, and handed down as words — see slaCue.
    sla: slaCue(t, now),
    lastActivityAt: t.lastActivityAt,
  }));

  const attention = attentionFor(counts, state, href);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = (page - 1) * pageSize + 1;
  const anyFilter = !!(state.category || state.priority || state.assignee !== "anyone" || state.q);
  // A confidential concern can't be in this person's rows, so a "Report a
  // concern" chip would only ever lead to an empty list. Kept while it's the
  // active filter, so it can still be switched off.
  const categories = TICKET_CATEGORIES.filter(
    (c) => scope.canSeeSensitive || !isSensitiveCategory(c) || state.category === c,
  );

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-ink">
            Support
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Requests filed at{" "}
            <Link href="/support" prefetch={false} className="underline">
              batch0.org/support
            </Link>{" "}
            and from every policy page, plus the ones the team logs from email
            or a call. Replying emails the requester and takes the request out
            of this queue; their follow-up puts it back. Needs reply is ordered
            by when a reply is due — urgent {SLA_TARGET_HOURS.urgent}h, high{" "}
            {SLA_TARGET_HOURS.high}h, normal {SLA_TARGET_HOURS.normal}h, low{" "}
            {SLA_TARGET_HOURS.low}h after their last message. Refund requests
            carry a 48-hour deadline measured from the payment, so work those
            first.
          </p>
        </div>
        {canManage && (
          <ButtonLink href="/admin/support/new" prefetch={false} size="sm">
            <Plus className="h-4 w-4" />
            Log a request
          </ButtonLink>
        )}
      </div>

      {attention.length > 0 && (
        <nav aria-label="Needs attention" className="mt-5 flex flex-wrap gap-2">
          {attention.map((a) => {
            const className = `inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums ${ATTENTION_TONE[a.tone]}`;
            const body = (
              <>
                <a.icon className="h-3.5 w-3.5" aria-hidden />
                {a.label}
              </>
            );
            // On the plain needs-reply view, "3 overdue" would link to the
            // page it's already on. Said, not linked, there.
            return a.href === here ? (
              <span key={a.key} className={className}>
                {body}
              </span>
            ) : (
              <Link
                key={a.key}
                href={a.href}
                prefetch={false}
                className={`press ${className} hover:border-ink/30`}
              >
                {body}
              </Link>
            );
          })}
        </nav>
      )}

      <nav aria-label="Views" className="mt-6 flex flex-wrap gap-1 border-b border-line">
        {STAFF_TICKET_VIEWS.map((v) => {
          const active = v === state.view;
          const n = counts.available ? counts[v] : null;
          return (
            <Link
              key={v}
              href={href({ view: v })}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={`-mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm ${
                active
                  ? "border-phosphor font-medium text-ink"
                  : "border-transparent text-ink-soft hover:text-ink"
              }`}
            >
              {STAFF_VIEW_LABELS[v]}
              {n != null &&
                (v === "needs_reply" && n > 0 ? (
                  <span className="ml-1.5 rounded-full bg-phosphor/15 px-1.5 text-[10px] tabular-nums text-phosphor-ink">
                    {n.toLocaleString("en-US")}
                  </span>
                ) : (
                  <span className="ml-1.5 text-[11px] tabular-nums text-ink-faint">
                    {n.toLocaleString("en-US")}
                  </span>
                ))}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <SupportSearch
          initialQuery={state.q}
          params={Object.fromEntries(queueParams({ ...state, q: "", page: 1 }))}
        />
        <FilterGroup label="Priority">
          {PRIORITY_FILTERS.map((f) => (
            <FilterChip key={f.label} href={href({ priority: f.value })} active={state.priority === f.value}>
              {f.label}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Owner">
          {OWNER_FILTERS.map((f) => (
            <FilterChip key={f.value} href={href({ assignee: f.value })} active={state.assignee === f.value}>
              {f.label}
            </FilterChip>
          ))}
        </FilterGroup>
        {anyFilter && (
          <Link
            href={href({ category: null, priority: null, assignee: "anyone", q: "" })}
            prefetch={false}
            className="text-xs text-ink-soft underline hover:text-ink"
          >
            Clear all
          </Link>
        )}
      </div>

      <nav aria-label="Categories" className="mt-3 flex flex-wrap gap-1.5">
        <FilterChip href={href({ category: null })} active={!state.category}>
          Every kind
        </FilterChip>
        {categories.map((c) => (
          <FilterChip key={c} href={href({ category: c })} active={state.category === c}>
            {CATEGORY_LABELS[c]}
          </FilterChip>
        ))}
      </nav>

      <Card className="mt-6 !p-0 overflow-hidden">
        {rows.length === 0 ? (
          <EmptyQueue
            searched={!!state.q && total === 0 && !error}
            {...emptyState({ state: { ...state, page }, counts, total, pageSize, failed: !!error, href })}
          />
        ) : (
          <SupportTicketTable rows={rows} />
        )}
      </Card>

      {rows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
          <span className="tabular-nums">
            {firstRow.toLocaleString("en-US")}–
            {(firstRow + rows.length - 1).toLocaleString("en-US")} of{" "}
            {total.toLocaleString("en-US")}
          </span>
          {lastPage > 1 && (
            <nav aria-label="Pages" className="flex gap-1">
              <PageLink href={page > 1 ? href({ page: page - 1 }) : null}>
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Previous
              </PageLink>
              <PageLink href={page < lastPage ? href({ page: page + 1 }) : null}>
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </PageLink>
            </nav>
          )}
        </div>
      )}

      {error && !isMissingTable(error) && (
        <p className="mt-3 text-xs text-red-500">
          The queue could not be read: {error.message}
        </p>
      )}
      {!canManage && (
        <p className="mt-3 text-xs text-ink-faint">
          You have read access to this queue. Answering a request needs the
          &ldquo;Answer support requests&rdquo; permission.
        </p>
      )}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

function FilterChip({
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
      aria-current={active ? "true" : undefined}
      className={`press rounded-full border px-3 py-1 text-xs ${
        active
          ? "border-phosphor bg-phosphor/15 text-ink"
          : "border-line text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

/** Previous / Next. A span when there's nowhere to go, so the pair never shifts. */
function PageLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  const shape = "inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5";
  return href ? (
    <Link href={href} prefetch={false} className={`press ${shape} hover:bg-wash`}>
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={`${shape} text-ink-faint`}>
      {children}
    </span>
  );
}

function EmptyQueue({
  searched,
  text,
  links,
}: {
  searched: boolean;
  text: string;
  links: { href: string; label: string }[];
}) {
  const Icon = searched ? SearchX : LifeBuoy;
  return (
    <div className="p-10 text-center">
      <Icon className="mx-auto h-8 w-8 text-ink-faint" aria-hidden />
      <p className="mt-3 text-sm text-ink-soft">{text}</p>
      {links.length > 0 && (
        <p className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
          {links.map((l) => (
            <Link key={l.label} href={l.href} prefetch={false} className="text-phosphor-ink hover:underline">
              {l.label}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}
