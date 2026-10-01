import Link from "next/link";
import { ArrowLeft, LifeBuoy, Plus } from "lucide-react";
import { requireViewer, roleHome } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { listTicketsForUser } from "@/lib/support";
import { CATEGORY_LABELS, STATUS_LABELS, isOpenStatus } from "@/lib/support-access";

export const metadata = { title: "Help & support · batch0" };
export const dynamic = "force-dynamic";

/**
 * "Help & support" — every request this account has sent the team.
 *
 * Carries no enrolment gate and is in both pre-cohort allowlists
 * (lib/pre-cohort.ts). That is the point: the 48-hour refund window falls
 * entirely before day one, so a student who has just paid and changed their
 * mind must not meet a LockedFeature here. Locking this page would be locking
 * the exit. For the same reason every role reaches it (lib/dashboard-gate.ts)
 * and a pending fine doesn't block it (lib/supabase/middleware.ts).
 *
 * Rows link to the owner's thread at /dashboard/support/<reference>, which the
 * session authorizes — never to the emailed /support/t/<token> link, whose
 * token must not reach a client-side navigation (and so analytics).
 */
export default async function DashboardSupportPage() {
  const { profile, caps } = await requireViewer();
  // A mentor, investor or custom staff role gets the dashboard's bare chrome
  // here (no student sidebar), so give them the way back to their own home.
  const studentView = can(caps, "student.dashboard");
  const [tickets, home] = await Promise.all([
    listTicketsForUser(profile.id),
    studentView ? Promise.resolve(null) : roleHome(profile.role),
  ]);

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {home && (
        <Link
          href={home}
          prefetch={false}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Help &amp; support</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Requests you&rsquo;ve sent the batch0 team, and what&rsquo;s
            happened to them. A reply lands in your email too.
          </p>
        </div>
        <ButtonLink href="/dashboard/support/new" prefetch={false} size="sm">
          <Plus className="h-3.5 w-3.5" />
          New request
        </ButtonLink>
      </div>

      {tickets.length === 0 ? (
        <Card className="mt-6">
          <div className="py-6 text-center">
            <LifeBuoy className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              You haven&rsquo;t sent us anything yet. Refunds, billing, account
              access, tech trouble, a concern, or a privacy request all start
              with a{" "}
              <Link href="/dashboard/support/new" prefetch={false} className="link-ink">
                new request
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
                className="press block rounded-xl border border-line bg-wash p-4 hover:border-ink/30"
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
                  {/* The recorded arrival time — the one that counts for a
                      refund — not when the row was written. */}
                  Recorded <LocalTime value={t.receivedAt} mode="datetime-short" />
                  {t.replyCount > 0 && (
                    <>
                      {" · "}
                      {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                    </>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
