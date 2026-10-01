import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { isMissingTable } from "@/lib/email/store";
import { countTicketsForStaff, listTicketsForStaff } from "@/lib/support";
import {
  CATEGORY_LABELS,
  STAFF_STATUS_LABELS,
  TICKET_CATEGORIES,
  supportScopeFor,
  toCategory,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/support-access";
import {
  SupportTicketTable,
  type SupportTicketRow,
} from "./ticket-table";

export const metadata = { title: "Support · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** One page of the queue; this page has no pagination controls yet. */
const SUPPORT_PAGE_LIMIT = 100;

/** The views, in the order someone working the queue wants them. */
const VIEWS = ["queue", "open", "waiting_on_requester", "resolved", "closed", "all"] as const;
type View = (typeof VIEWS)[number];

/** One URL builder, so a view click keeps the category filter and vice versa. */
function hrefFor(view: View, category: TicketCategory | null) {
  const params = new URLSearchParams();
  if (view !== "queue") params.set("view", view);
  if (category) params.set("category", category);
  return `/admin/support${params.toString() ? `?${params}` : ""}`;
}

export default async function AdminSupportPage(props: {
  searchParams: Promise<{ view?: string; category?: string }>;
}) {
  const [searchParams, viewer] = await Promise.all([
    props.searchParams,
    requirePermission("support.view"),
  ]);

  const view: View =
    (VIEWS.find((v) => v === searchParams.view) as View) ?? "queue";
  const category = searchParams.category
    ? toCategory(searchParams.category)
    : null;

  // "queue" is the default and is not a status — it is "anything still waiting
  // on us", across open and reopened tickets alike, which is exactly the open
  // tickets (the data layer's "needs_reply" view). Every other view is a
  // straight status filter. The scope carries the confidentiality rule.
  const scope = supportScopeFor(viewer.profile.id, viewer.caps);
  const [{ tickets, error }, counts] = await Promise.all([
    listTicketsForStaff(
      {
        view: view === "queue" || view === "open" ? "needs_reply" : view,
        category,
        pageSize: SUPPORT_PAGE_LIMIT,
      },
      scope,
    ),
    countTicketsForStaff(scope),
  ]);

  if (error && isMissingTable(error)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
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
    assignedName: t.assignedName,
    replyCount: t.replyCount,
    needsReply: t.needsReply,
    lastActivityAt: t.lastActivityAt,
    createdAt: t.createdAt,
  }));

  const chipCount = (v: View) =>
    !counts.available
      ? null
      : v === "queue" || v === "open"
        ? counts.needs_reply
        : counts[v];

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Support
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Requests filed at{" "}
            <Link href="/support" prefetch={false} className="underline">
              batch0.org/support
            </Link>{" "}
            and from every policy page. Replying emails the requester and takes
            the request out of this queue; their follow-up puts it back.
            Refund requests carry a 48-hour deadline measured from the payment,
            so work those first.
          </p>
        </div>
      </div>

      <nav aria-label="Views" className="mt-6 flex flex-wrap gap-1.5">
        {VIEWS.map((v) => {
          const active = v === view;
          const n = chipCount(v);
          return (
            <Link
              key={v}
              href={hrefFor(v, category)}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                active
                  ? "border-phosphor text-ink"
                  : "border-line text-ink-soft hover:text-ink"
              }`}
            >
              {v === "queue"
                ? "Needs reply"
                : v === "all"
                  ? "All"
                  : STAFF_STATUS_LABELS[v as TicketStatus]}
              {n != null && <span className="ml-1.5 tabular-nums">{n}</span>}
            </Link>
          );
        })}
      </nav>

      <nav aria-label="Categories" className="mt-2 flex flex-wrap gap-1.5">
        <Link
          href={hrefFor(view, null)}
          prefetch={false}
          aria-current={!category ? "page" : undefined}
          className={`rounded-full border px-3 py-1 text-xs ${
            !category
              ? "border-phosphor bg-phosphor/15 text-ink"
              : "border-line text-ink-soft hover:text-ink"
          }`}
        >
          Every kind
        </Link>
        {TICKET_CATEGORIES.map((c) => (
          <Link
            key={c}
            href={hrefFor(view, c)}
            prefetch={false}
            aria-current={category === c ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs ${
              category === c
                ? "border-phosphor bg-phosphor/15 text-ink"
                : "border-line text-ink-soft hover:text-ink"
            }`}
          >
            {CATEGORY_LABELS[c]}
          </Link>
        ))}
      </nav>

      <Card className="mt-6 !p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center">
            <LifeBuoy className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              {view === "queue" && !category
                ? "Inbox zero. Every request has a reply."
                : "Nothing matches that filter."}
            </p>
          </div>
        ) : (
          <SupportTicketTable rows={rows} />
        )}
      </Card>

      {rows.length === SUPPORT_PAGE_LIMIT && (
        <p className="mt-3 text-xs text-ink-faint">
          {/* The default queue is sorted oldest-activity-first so the
              longest-waiting person is on top, which means the rows dropped
              here are the NEWEST ones — the opposite of every other truncation
              note in the panel. Saying "most recent" would be actively
              misleading about which requests are missing. */}
          {view === "queue"
            ? `Showing the ${SUPPORT_PAGE_LIMIT} longest-waiting requests. Newer ones are not listed.`
            : `Showing the ${SUPPORT_PAGE_LIMIT} most recent requests for this filter.`}
        </p>
      )}
      {error && !isMissingTable(error) && (
        <p className="mt-3 text-xs text-red-500">
          The queue could not be read: {error.message}
        </p>
      )}
      {!viewer.caps.superAdmin &&
        !viewer.caps.permissions.includes("support.manage") && (
          <p className="mt-3 text-xs text-ink-faint">
            You have read access to this queue. Answering a request needs the
            &ldquo;Answer support requests&rdquo; permission.
          </p>
        )}
    </div>
  );
}
