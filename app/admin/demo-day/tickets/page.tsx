import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { getSiteConfig } from "@/lib/site-config";
import { Card, StatusBadge } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { ticketPayUrl } from "@/lib/demo-day-tickets";
import { formatTicketAmount, TICKET_STATUSES } from "@/lib/demo-day-ticket-input";
import type { DemoDayTicket } from "@/lib/types";
import { TicketForm } from "./ticket-form";
import { TicketRowActions } from "./ticket-row-actions";
import { ExternalLink } from "lucide-react";

export const metadata = { title: "Demo Day tickets · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FILTERS = ["all", ...TICKET_STATUSES] as const;

/**
 * Send someone a paid link for Demo Day only — not the cohort — at any price.
 * The list below is every ticket ever sent, with what happened to it.
 *
 * Gated on demoday.manage: /admin/demo-day/tickets resolves to it through
 * the longest-prefix route map (lib/permissions.ts), which the middleware and
 * the admin layout both enforce; the server actions re-check it themselves.
 */
export default async function AdminDemoDayTicketsPage(props: {
  searchParams: Promise<{ status?: string; email?: string; name?: string }>;
}) {
  const searchParams = await props.searchParams;
  await requirePermission("demoday.manage");
  const admin = createAdminClient();
  const status = (searchParams.status ?? "all") || "all";

  let q = admin
    .from("demo_day_tickets")
    .select("*, cohort:cohorts(name)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (status !== "all") q = q.eq("status", status);

  const [{ data: rows }, { data: cohorts }, config] = await Promise.all([
    q,
    admin
      .from("cohorts")
      .select("id, name")
      .order("starts_on", { ascending: false }),
    getSiteConfig(),
  ]);

  const tickets = (rows ?? []) as (DemoDayTicket & { cohort: any })[];
  const paid = tickets.filter((t) => t.status === "paid");
  const revenueCents = paid.reduce((s, t) => s + t.amount_cents, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-faint">
            <Link href="/admin/demo-day" className="hover:text-ink">
              Demo Day
            </Link>{" "}
            / Tickets
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Demo Day tickets
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            Send someone a paid link to Demo Day only — no cohort enrollment.
            Set any price; they get an email with a pay link and don&rsquo;t
            need a batch0 account.
          </p>
        </div>
        <ButtonLink href="/admin/demo-day" variant="secondary" size="sm">
          ← Demo Day
        </ButtonLink>
      </div>

      <Card className="mt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Send a ticket
        </h2>
        <TicketForm
          cohorts={(cohorts ?? []).map((c: any) => ({ id: c.id, name: c.name }))}
          defaultCohortId={config.cohort?.id ?? (cohorts?.[0] as any)?.id ?? null}
          initialName={searchParams.name}
          initialEmail={searchParams.email}
        />
      </Card>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-ink-faint">
          Status
        </span>
        {FILTERS.map((s) => {
          const active = status === s;
          return (
            <Link
              key={s}
              href={`/admin/demo-day/tickets?status=${s}`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-phosphor bg-phosphor/10 text-phosphor"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {s}
            </Link>
          );
        })}
        <span className="ml-auto text-xs text-ink-faint">
          {paid.length} paid · {formatTicketAmount(revenueCents)}
          {status !== "all" ? " (in this view)" : ""}
        </span>
      </div>

      <Card className="mt-4 !p-0 overflow-hidden">
        {tickets.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-faint">
            {status === "all"
              ? "No tickets sent yet."
              : `No ${status} tickets.`}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line bg-wash text-left text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  <th className="px-4 py-2">Sent</th>
                  <th className="px-4 py-2">To</th>
                  <th className="px-4 py-2">Demo Day</th>
                  <th className="px-4 py-2">Price</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tickets.map((t) => {
                  const cohort = Array.isArray(t.cohort) ? t.cohort[0] : t.cohort;
                  return (
                    <tr key={t.id} className="align-top">
                      <td className="px-4 py-3 text-xs text-ink-soft whitespace-nowrap">
                        <LocalTime value={t.created_at} />
                        {t.sent_at && t.sent_at !== t.created_at && (
                          <div className="text-[10px] text-ink-faint">
                            resent <LocalTime value={t.sent_at} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-ink">{t.name ?? "—"}</div>
                        <div className="text-xs text-ink-faint">
                          {t.user_id ? (
                            <Link
                              href={`/admin/students/${t.user_id}`}
                              className="hover:text-ink hover:underline"
                              title="Matched a batch0 account"
                            >
                              {t.email}
                            </Link>
                          ) : (
                            t.email
                          )}
                        </div>
                        {t.note && (
                          <div className="mt-1 max-w-xs truncate text-[11px] text-ink-faint" title={t.note}>
                            “{t.note}”
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-soft">
                        {cohort?.name ?? "Any"}
                      </td>
                      <td className="px-4 py-3 font-semibold tabular-nums text-ink">
                        {t.scholarship_application_id ? (
                          // A complimentary ticket a scholarship holder sent
                          // (0074): nothing was paid, and "$0" alone reads as
                          // a pricing mistake rather than a gift.
                          <span
                            title="Complimentary guest ticket, sent by a scholarship holder"
                            className="inline-flex items-center rounded-md border border-phosphor/40 bg-phosphor/[0.08] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-phosphor-ink"
                          >
                            Guest
                          </span>
                        ) : (
                          formatTicketAmount(t.amount_cents)
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={t.status} />
                        {t.status === "paid" && t.paid_at && (
                          <div className="mt-1 text-[10px] text-ink-faint">
                            <LocalTime value={t.paid_at} />
                            {t.stripe_receipt_url && (
                              <>
                                {" · "}
                                <a
                                  href={t.stripe_receipt_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 hover:text-ink"
                                >
                                  receipt <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              </>
                            )}
                          </div>
                        )}
                        {t.status === "refunded" && t.refund_reason && (
                          <div className="mt-1 max-w-[12rem] truncate text-[10px] text-ink-faint" title={t.refund_reason}>
                            {t.refund_reason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <TicketRowActions
                          ticketId={t.id}
                          status={t.status}
                          url={ticketPayUrl(t.token)}
                          guest={!!t.scholarship_application_id}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
