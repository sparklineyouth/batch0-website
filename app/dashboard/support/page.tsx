import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { listTicketsForUser } from "@/lib/support";
import { CATEGORY_LABELS, STATUS_LABELS, isOpenStatus } from "@/lib/support-access";

export const metadata = { title: "Support · batch0" };
export const dynamic = "force-dynamic";

/**
 * "My requests" — every ticket this account has filed.
 *
 * Carries no enrolment gate and is in both pre-cohort allowlists
 * (lib/pre-cohort.ts). That is the point: the 48-hour refund window falls
 * entirely before day one, so a student who has just paid and changed their
 * mind must not meet a LockedFeature here. Locking this page would be locking
 * the exit.
 *
 * Rows link to the owner's thread at /dashboard/support/<reference>, which the
 * session authorizes — never to the emailed /support/t/<token> link, whose
 * token must not reach a client-side navigation (and so analytics).
 */
export default async function DashboardSupportPage() {
  const { profile } = await requireViewer();
  const tickets = await listTicketsForUser(profile.id);

  return (
    <div className="mx-auto max-w-3xl pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Support
          </h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Requests you&rsquo;ve sent the batch0 team, and what&rsquo;s
            happened to them. A reply lands in your email too.
          </p>
        </div>
        <Link
          href="/support"
          prefetch={false}
          className="inline-flex h-10 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md bg-phosphor px-4 text-sm font-semibold leading-none text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98]"
        >
          New request
        </Link>
      </div>

      {tickets.length === 0 ? (
        <Card className="mt-6">
          <div className="py-6 text-center">
            <LifeBuoy className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              You haven&rsquo;t sent us anything yet. Refunds, billing,
              account access, or a privacy request all start at{" "}
              <Link href="/support" prefetch={false} className="link-ink">
                batch0.org/support
              </Link>
              .
            </p>
          </div>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {tickets.map((t) => (
            <li key={t.id}>
              <Link
                href={`/dashboard/support/${t.reference}`}
                prefetch={false}
                className="block rounded-xl border border-line bg-wash p-4 hover:border-ink/30"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                    {t.reference}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wider ${
                      isOpenStatus(t.status)
                        ? "bg-phosphor/15 text-phosphor-ink"
                        : "border border-line text-ink-faint"
                    }`}
                  >
                    {STATUS_LABELS[t.status]}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {CATEGORY_LABELS[t.category]}
                  </span>
                </div>
                <p className="mt-2 font-medium text-ink">{t.subject}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  Opened <LocalTime value={t.createdAt} mode="datetime-short" />
                  {t.replyCount > 0 && (
                    <>
                      {" · "}
                      {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                    </>
                  )}
                  {t.needsReply && " · waiting on us"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
