import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { requireAdminArea } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ADMIN_NAV_GROUPS, filterAdminNavItem } from "@/lib/nav-config";
import {
  ArrowRight,
  Inbox,
  GraduationCap,
  CreditCard,
  CheckCircle,
} from "lucide-react";

export const metadata = { title: "Admin · batch0" };

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export default async function AdminOverview() {
  // Every admin-area role lands here, so each block is gated by the same
  // permission as the page it summarises — an intern without `payments.view`
  // must not learn total revenue from the overview.
  const { caps } = await requireAdminArea();
  const seeApplications = can(caps, "applications.view");
  const seePeople = can(caps, "people.view");
  const seeRevenue = can(caps, "payments.view");

  const admin = createAdminClient();

  const [
    { count: totalApps },
    { count: pendingApps },
    { count: acceptedApps },
    { count: enrolledCount },
    { data: paymentsData },
    { data: chargesData },
    { data: recentApps },
  ] = await Promise.all([
    seeApplications
      ? admin.from("applications").select("id", { count: "exact", head: true })
      : { count: null },
    seeApplications
      ? admin
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("status", "submitted")
      : { count: null },
    seeApplications
      ? admin
          .from("applications")
          .select("id", { count: "exact", head: true })
          .eq("status", "accepted")
      : { count: null },
    seePeople
      ? admin.from("enrollments").select("id", { count: "exact", head: true })
      : { count: null },
    // Revenue tiles sum amount columns row-by-row, capped explicitly — past
    // ~10k rows the totals need to move to a SQL aggregate RPC instead.
    seeRevenue
      ? admin
          .from("payments")
          .select("amount_cents")
          .eq("status", "succeeded")
          .limit(10000)
      : { data: null },
    // Paid fees/fines count toward revenue too; refunded rows don't.
    seeRevenue
      ? admin
          .from("user_charges")
          .select("amount_cents")
          .eq("status", "paid")
          .limit(10000)
      : { data: null },
    seeApplications
      ? admin
          .from("applications")
          .select("id, full_name, status, submitted_at, created_at")
          .order("created_at", { ascending: false })
          .limit(8)
      : { data: null },
  ]);

  const enrollmentRevenueCents = (paymentsData ?? []).reduce(
    (sum, p) => sum + (p.amount_cents ?? 0),
    0,
  );
  const chargesRevenueCents = (chargesData ?? []).reduce(
    (sum, c) => sum + (c.amount_cents ?? 0),
    0,
  );
  const revenueCents = enrollmentRevenueCents + chargesRevenueCents;

  const inboxItems = seeApplications
    ? [
        {
          icon: Inbox,
          label: "Pending review",
          count: pendingApps ?? 0,
          href: "/admin/applications?status=submitted",
          tone: (pendingApps ?? 0) > 0 ? "phosphor" : "muted",
        },
        {
          icon: CreditCard,
          label: "Awaiting payment",
          count: acceptedApps ?? 0,
          href: "/admin/applications?status=accepted",
          tone: (acceptedApps ?? 0) > 0 ? "phosphor" : "muted",
        },
      ]
    : [];

  const metrics = [
    seeApplications && {
      icon: Inbox,
      label: "Total applications",
      value: String(totalApps ?? 0),
    },
    seePeople && {
      icon: GraduationCap,
      label: "Enrolled",
      value: String(enrolledCount ?? 0),
    },
    seeRevenue && {
      icon: CheckCircle,
      label: "Revenue",
      value: fmtMoney(revenueCents),
      hint:
        chargesRevenueCents > 0
          ? `Enrollments ${fmtMoney(enrollmentRevenueCents)} + fees/fines ${fmtMoney(chargesRevenueCents)}`
          : undefined,
    },
  ].filter(Boolean) as {
    icon: any;
    label: string;
    value: string;
    hint?: string;
  }[];

  // What this person can actually open. Doubles as the empty state for a
  // narrow role whose whole job lives in one or two sections.
  const reachable = ADMIN_NAV_GROUPS.flatMap((g) => g.items).filter(
    (it) => it.href !== "/admin" && filterAdminNavItem(it, caps),
  );

  return (
    <div className="mx-auto max-w-6xl">
      {/* Hero row */}
      <div className="border-b border-line pb-8">
        <p className="text-[11px] font-mono font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          Admin overview
        </p>
        <h1 className="mt-3 font-display text-4xl md:text-5xl font-bold tracking-[-0.02em] text-ink">
          What needs your attention.
        </h1>
        <p className="mt-3 max-w-xl text-[15px] text-ink-soft leading-relaxed">
          {metrics.length > 0
            ? "Daily snapshot of the program — limited to what your role can see."
            : "Your role covers a focused slice of the program. Jump straight to it below."}
        </p>
      </div>

      {/* Inbox row — actionable counts, not vanity stats. */}
      {inboxItems.length > 0 && (
        <section className="mt-8 grid gap-3 md:grid-cols-2">
          {inboxItems.map((it) => (
            <Link
              key={it.label}
              href={it.href}
              className="press group flex items-center gap-4 rounded-xl border border-line bg-wash px-5 py-4 hover:border-ink/30"
            >
              <it.icon
                className={`h-5 w-5 shrink-0 ${
                  it.tone === "phosphor" ? "text-phosphor-ink" : "text-ink-faint"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-mono font-medium uppercase tracking-[0.2em] text-ink-faint">
                  {it.label}
                </p>
                <p
                  className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums ${
                    it.tone === "phosphor" ? "text-phosphor-ink" : "text-ink"
                  }`}
                >
                  {it.count}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink" />
            </Link>
          ))}
        </section>
      )}

      {/* Program metrics — editorial, not card-y. */}
      {metrics.length > 0 && (
        <section
          className={`mt-12 grid gap-6 border-y border-line py-8 ${
            metrics.length === 1
              ? "grid-cols-1"
              : metrics.length === 2
                ? "grid-cols-2"
                : "grid-cols-3"
          }`}
        >
          {metrics.map((m) => (
            <Metric
              key={m.label}
              icon={m.icon}
              label={m.label}
              value={m.value}
              hint={m.hint}
            />
          ))}
        </section>
      )}

      {/* Recent applications — editorial list, no inner card chrome. */}
      {seeApplications && (
        <section className="mt-12">
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
              Recent applications
            </h2>
            <Link
              href="/admin/applications"
              className="press text-sm text-phosphor-ink hover:underline"
            >
              View all →
            </Link>
          </div>
          {(recentApps?.length ?? 0) === 0 ? (
            <p className="rounded-xl border border-line bg-wash px-5 py-8 text-center text-sm text-ink-soft">
              No applications yet.
            </p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {recentApps!.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/admin/applications/${a.id}`}
                    className="press group flex items-center gap-4 py-4 hover:bg-wash"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium text-ink">
                        {a.full_name || "Unnamed applicant"}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-faint font-mono tabular-nums">
                        <LocalTime
                          value={a.submitted_at || a.created_at}
                          mode="datetime-short"
                        />
                      </p>
                    </div>
                    <StatusBadge status={a.status} />
                    <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Your areas — the sections this role owns. */}
      {reachable.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-5 font-display text-lg font-semibold tracking-tight text-ink">
            Your areas
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {reachable.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className="press group flex items-center gap-3 rounded-lg border border-line bg-wash px-4 py-3 text-sm text-ink hover:border-ink/30"
              >
                <it.icon className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink" />
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint group-hover:text-ink" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[10px] font-mono font-medium uppercase tracking-[0.22em] text-ink-faint">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight tabular-nums text-ink">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>
      )}
    </div>
  );
}
