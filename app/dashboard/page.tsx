import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ButtonLink } from "@/components/ui/button";
import { ReferralCard } from "./referral-card";
import { FounderPassCard } from "./founder-pass-card";
import { getPassForUser } from "@/lib/founder-pass";
import { ChargePayButton } from "@/components/charge-pay-button";
import { getStudentAccess, type StudentAccess } from "@/lib/access";
import { fmtDateOnly, PRE_COHORT_ALLOWED_HREFS } from "@/lib/pre-cohort";
import { ENROLLED_ONLY_HREFS } from "@/lib/nav-config";
import type { Role } from "@/lib/types";
import { env } from "@/lib/env";
import {
  AlertCircle,
  ArrowRight,
  PlayCircle,
  FileText,
  CalendarDays,
  GraduationCap,
  Handshake,
} from "lucide-react";
import { getSiteConfig } from "@/lib/site-config";

export default async function DashboardHome() {
  const user = await requireUser();
  const supabase = createClient();
  const adminClient = createAdminClient();

  // One batch for everything that needs only the signed-in user. The profile
  // comes from the request-cached getProfile() the layout already resolved,
  // and getStudentAccess (also request-cached, shared with the layout) rides
  // the same batch chained off the role it needs. The applications and
  // enrollments reads stay: the page renders the enrollment's cohort dates
  // and the exact latest application row, which StudentAccess doesn't carry.
  const profilePromise = getProfile();
  const siteConfigPromise = getSiteConfig();
  const accessPromise = profilePromise.then((p) =>
    getStudentAccess((p?.role as Role) ?? "student"),
  );
  const membershipsPromise = adminClient
    .from("team_members")
    .select("team_id")
    .eq("user_id", user.id);

  // Intros and the referral count used to sit in a SECOND `await Promise.all`
  // below this one — a fifth serial wave paid by every visitor, even though
  // neither depends on the batch as a whole. Chaining each off only the
  // promises it genuinely needs lets both overlap the reads above instead of
  // queueing behind all of them. For the common cases (referrals off or no
  // code; pre-cohort or team-less student) they now settle without issuing a
  // query at all.
  const referralCountPromise = Promise.all([
    profilePromise,
    siteConfigPromise,
  ]).then(([p, cfg]) =>
    cfg.settings.referralsEnabled && p?.referral_code
      ? countReferrals(p.referral_code)
      : 0,
  );
  // Active intros for the user's teams. We surface "wired" deals at
  // the top of the dashboard so the team sees them the moment they
  // happen. Best-effort: missing migration 0019 or no team → empty.
  // Intros are a cohort feature — don't surface (or link to) them during
  // pre-cohort lockdown; the route would just bounce back home anyway.
  const introsPromise = Promise.all([accessPromise, membershipsPromise]).then(
    ([acc, { data: rows }]) => {
      const ids = (rows ?? [])
        .map((m: any) => m.team_id as string)
        .filter(Boolean);
      if (acc.preCohort || ids.length === 0) return [] as any[];
      return adminClient
        .from("intro_requests")
        .select(
          "id, status, updated_at, investor:profiles!intro_requests_investor_id_fkey(full_name, email), team:teams(name)",
        )
        .in("team_id", ids)
        .order("updated_at", { ascending: false })
        .then(({ data }) => (data ?? []) as any[]);
    },
  );

  const [
    profile,
    // Pre-cohort lockdown state: accepted/enrolled but the cohort hasn't
    // started. The whole page reflects it — hero copy, locked rows, and
    // quick links only point at pages the middleware actually allows.
    access,
    siteConfig,
    { data: app },
    { data: enrollment },
    { data: pendingFees },
    { data: certificate },
    // Null for everyone without a redeemed card, which is most people — the
    // card block below simply doesn't render for them.
    founderPass,
    { data: memberships },
    intros,
    referralCount,
  ] = await Promise.all([
    profilePromise,
    accessPromise,
    siteConfigPromise,
    // Only .status is rendered — the essay columns stay in the database.
    supabase
      .from("applications")
      .select("status")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("enrollments")
      .select("id, cohort:cohorts(name, starts_on, ends_on)")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("user_charges")
      .select("*")
      .eq("user_id", user.id)
      .eq("kind", "fee")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("certificates")
      .select("code")
      .eq("user_id", user.id)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getPassForUser(adminClient, user.id),
    membershipsPromise,
    introsPromise,
    referralCountPromise,
  ]);
  const priceLabel = siteConfig.derived.priceLabel;
  const preCohort = access.preCohort;
  const startDate = fmtDateOnly(access.cohortStartsOn);

  // Supabase embeds to-one relations as object or single-element array (and
  // the client types the named embed as an array) — normalize once here.
  const enrollmentCohort: {
    name: string | null;
    starts_on: string | null;
    ends_on: string | null;
  } | null = (() => {
    const c = (enrollment?.cohort ?? null) as any;
    return Array.isArray(c) ? (c[0] ?? null) : c;
  })();

  const teamIds = (memberships ?? [])
    .map((m: any) => m.team_id as string)
    .filter(Boolean);

  const wiredIntros = intros.filter((r: any) => r.status === "wired");
  const liveIntroCount = intros.filter(
    (r: any) => r.status !== "wired" && r.status !== "passed",
  ).length;

  const greeting = profile?.full_name?.split(" ")[0] || "there";

  // Status copy + primary action are derived together so the hero feels
  // intentional — no double-card with redundant labels.
  const status = appStatus(app?.status, access, startDate);
  const cohortOpen = !!enrollment && !preCohort;

  return (
    <div className="mx-auto max-w-5xl">
      {/* Hero row — name + lifecycle stage. Mirrors the marketing voice. */}
      <div className="border-b border-line pb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          {status.label}
        </p>
        <h1 className="mt-3 text-4xl md:text-5xl font-bold tracking-[-0.02em] text-ink">
          Welcome, {greeting}.
        </h1>
        <p className="mt-3 max-w-xl text-[15px] text-ink-soft leading-relaxed">
          {status.lede(priceLabel)}
        </p>
        {status.cta && (
          <div className="mt-6">
            {/* ButtonLink, not <Link><Button> — the latter renders
                <a><button>, which is two tab stops with two different focus
                rings for one control. This is the dashboard's single primary
                action, so it is the worst place on the page to have it. */}
            <ButtonLink href={status.cta.href}>
              {status.cta.label(priceLabel)}
              <ArrowRight className="h-4 w-4 shrink-0" />
            </ButtonLink>
          </div>
        )}
      </div>

      {/* Wired intros — the loudest possible signal. If money landed,
       *  the team should see it the moment they open the dashboard. */}
      {wiredIntros.length > 0 && (
        <section className="mt-8 space-y-3">
          {wiredIntros.map((i: any) => {
            const investor = Array.isArray(i.investor)
              ? i.investor[0]
              : i.investor;
            const team = Array.isArray(i.team) ? i.team[0] : i.team;
            const name =
              investor?.full_name ?? investor?.email ?? "An investor";
            return (
              <Link
                key={i.id}
                href="/dashboard/intros"
                className="press group flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4 hover:border-emerald-500/40 hover:bg-emerald-500/[0.15]"
              >
                <Handshake className="h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                <div className="min-w-0 flex-1">
                  {/* `name` falls back to an email address, which has no
                      natural break opportunity — min-w-0 alone lets it run
                      under the arrow and get clipped by the body's
                      overflow-x: clip at narrow widths. */}
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 break-words [overflow-wrap:anywhere]">
                    {name} wired your team{team?.name ? ` (${team.name})` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                    Funds received <LocalTime value={i.updated_at} mode="date" />.
                    Open intros for next steps.
                  </p>
                </div>
                {/* The group-hover values used to repeat the base colour
                    exactly, so hovering the loudest card on the page moved
                    nothing. Darken on hover instead, in both themes. */}
                <ArrowRight className="h-4 w-4 shrink-0 text-emerald-700 group-hover:text-emerald-900 dark:text-emerald-300 dark:group-hover:text-emerald-100" />
              </Link>
            );
          })}
        </section>
      )}

      {/* Fees due — surfaced above the fold when present. */}
      {(pendingFees?.length ?? 0) > 0 && (
        <section className="mt-8 space-y-3">
          {(pendingFees ?? []).map((f: any) => (
            <div
              key={f.id}
              className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  Fee due — {f.description}
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">
                  ${(f.amount_cents / 100).toFixed(2)}. Settle when you can;
                  batch0 stays open in the meantime.
                </p>
              </div>
              <ChargePayButton chargeId={f.id} />
            </div>
          ))}
        </section>
      )}

      {/* Two editorial blocks: program + this week. */}
      <section className="mt-10 grid gap-10 md:grid-cols-12">
        <div className="md:col-span-7">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Program
          </h2>
          <div className="mt-4 border-t border-line">
            <Row
              icon={GraduationCap}
              label="Cohort"
              value={
                enrollment
                  ? enrollmentCohort?.name ?? "Enrolled"
                  : "Not enrolled yet"
              }
              sub={
                enrollment
                  ? `${enrollmentCohort?.starts_on ?? "—"} → ${enrollmentCohort?.ends_on ?? "—"}`
                  : "Apply to claim a seat."
              }
            />
            <Row
              icon={FileText}
              label="Application"
              value={app ? statusTitle(app.status) : "Not started"}
              statusBadge={app?.status}
              href="/dashboard/application"
            />
            <Row
              icon={PlayCircle}
              label="Course"
              value={cohortOpen ? "Open" : "Locked"}
              sub={
                cohortOpen
                  ? "Weekly modules + assignments"
                  : enrollment && preCohort
                    ? `Unlocks when the cohort starts${startDate ? ` on ${startDate}` : ""}`
                    : "Unlocks at enrollment"
              }
              href={cohortOpen ? "/dashboard/course" : undefined}
              muted={!cohortOpen}
            />
            <Row
              icon={CalendarDays}
              label="Events"
              value={cohortOpen ? "View schedule" : "Locked"}
              sub={
                cohortOpen
                  ? "Office hours + Demo Day"
                  : enrollment && preCohort
                    ? `Unlocks when the cohort starts${startDate ? ` on ${startDate}` : ""}`
                    : "Unlocks at enrollment"
              }
              href={cohortOpen ? "/dashboard/events" : undefined}
              muted={!cohortOpen}
            />
            {cohortOpen && teamIds.length > 0 && (
              <Row
                icon={Handshake}
                label="Investor intros"
                value={
                  liveIntroCount > 0
                    ? `${liveIntroCount} in flight`
                    : "Nothing yet"
                }
                sub={
                  liveIntroCount > 0
                    ? "Investors actively interested in your team"
                    : "Investors browse after Demo Day"
                }
                href="/dashboard/intros"
              />
            )}
          </div>
        </div>

        <aside className="md:col-span-5">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Quick links
          </h2>
          <ul className="mt-4 grid grid-cols-2 gap-2">
            {[
              { href: "/dashboard/application", label: "Application" },
              { href: "/dashboard/kickoff", label: "Kickoff" },
              { href: "/dashboard/announcements", label: "Announcements" },
              { href: "/dashboard/billing", label: "Billing" },
              { href: "/dashboard/team", label: "Team" },
              { href: "/dashboard/checkin", label: "Check-in" },
              { href: "/dashboard/resources", label: "Resources" },
              { href: "/dashboard/settings", label: "Settings" },
            ]
              .filter((l) => {
                // Kickoff stays with an enrolled student for the whole
                // cohort — a countdown, then the record of day one. Mirrors
                // filterStudentNavItem in lib/nav-config.ts.
                if (l.href === "/dashboard/kickoff") {
                  return access.enrolled;
                }
                // Don't dangle dead-end links at a student whose seat
                // isn't paid for — same set the sidebar hides.
                if (!access.enrolled && ENROLLED_ONLY_HREFS.has(l.href)) {
                  return false;
                }
                // Pre-cohort: only link to pages the middleware allows —
                // same source of truth as the sidebar and the hard gate.
                return !preCohort || PRE_COHORT_ALLOWED_HREFS.has(l.href);
              })
              .map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="press group flex items-center justify-between rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink-soft hover:border-ink/30 hover:bg-wash hover:text-ink"
                >
                  <span>{l.label}</span>
                  {/* Was pinned to text-ink-faint, so all seven tiles
                      brightened their label, border and background on hover
                      while the arrow alone stayed dead. Matches Row() below. */}
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint group-hover:text-ink-soft" />
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      {founderPass && (
        <div className="mt-12">
          <FounderPassCard
            serial={founderPass.serial}
            batch={founderPass.batch}
          />
        </div>
      )}

      {siteConfig.settings.referralsEnabled && profile?.referral_code && (
        <div className="mt-12">
          <ReferralCard
            code={profile.referral_code}
            siteUrl={env.siteUrl}
            referralCount={referralCount}
          />
        </div>
      )}

      {certificate && (
        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-phosphor/30 bg-phosphor/[0.04] px-5 py-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
              Certificate of completion
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              You graduated. Share it on LinkedIn or anywhere.
            </p>
          </div>
          <ButtonLink href={`/verify/${certificate.code}`} size="sm">
            View certificate
            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
          </ButtonLink>
        </div>
      )}
    </div>
  );
}

type StatusBucket = {
  label: string;
  lede: (price: string) => string;
  cta: { href: string; label: (price: string) => string } | null;
};

function appStatus(
  s: string | null | undefined,
  access: StudentAccess,
  startDate: string | null,
): StatusBucket {
  // Pre-cohort lockdown: the hero must reflect it no matter which
  // application row happens to be newest (an admin-enrolled student may
  // have no application at all, or a fresh draft for the next cycle).
  if (access.preCohort) {
    // Accepted but not yet enrolled → the pay CTA still leads.
    if (!access.enrolled && s === "accepted") {
      return {
        label: "Application · Accepted",
        lede: (price) =>
          `You're in. Lock in your seat with the one-time ${price} tuition` +
          `${startDate ? ` — the cohort starts ${startDate}` : ""}. ` +
          "Paying unlocks kickoff details, your team page, and the " +
          "pre-cohort resources.",
        cta: {
          href: "/dashboard/accepted",
          label: (price) => `Pay ${price} to enroll`,
        },
      };
    }
    // Enrolled (or paid) — the course isn't open yet, so the hero points
    // at what IS open: kickoff, pre-cohort resources, Discord, and the
    // team page (co-founders can be lined up before day one).
    return {
      label: "Enrolled",
      lede: () =>
        `You're enrolled${access.cohortName ? ` in ${access.cohortName}` : ""}. ` +
        `The cohort kicks off${startDate ? ` on ${startDate}` : " soon"} — ` +
        "kickoff, Discord, your team page, and the pre-cohort resources " +
        "are open for you now.",
      cta: {
        href: "/dashboard/kickoff",
        label: () => "See kickoff details",
      },
    };
  }
  switch (s) {
    case "draft":
      return {
        label: "Application · Draft",
        lede: () =>
          "Pick up where you left off. Saves autosave as you type.",
        cta: { href: "/apply", label: () => "Continue application" },
      };
    case "submitted":
      return {
        label: "Application · In review",
        lede: () =>
          "We're reading your application. You'll get an email when there's a decision.",
        cta: null,
      };
    case "waitlisted":
      return {
        label: "Application · Waitlisted",
        lede: () =>
          "You're on the waitlist — not a no. If a seat opens, you're first in line and we'll email you right away.",
        cta: null,
      };
    case "accepted":
      return {
        label: "Application · Accepted",
        lede: (price) =>
          `You're in. Lock in your seat with the one-time ${price} tuition.`,
        cta: {
          href: "/dashboard/accepted",
          label: (price) => `Pay ${price} to enroll`,
        },
      };
    case "rejected":
      return {
        label: "Application · Closed",
        lede: () =>
          "You weren't selected for this cohort. You can apply again to a different one when it opens.",
        cta: { href: "/apply", label: () => "Apply to another cohort" },
      };
    case "paid":
    case "enrolled":
      return {
        label: "Enrolled",
        lede: () =>
          "You're enrolled. Open your course to see this week's deliverables.",
        cta: { href: "/dashboard/course", label: () => "Open course" },
      };
    default:
      return {
        label: "Get started",
        // No duration claim here: the cohort runs Aug 17 → Oct 18, so the old
        // "in four weeks" was wrong. The real dates are on /program and the
        // ledger; this line doesn't need to restate them.
        lede: () =>
          "Take your idea from raw concept to investor-ready pitch.",
        cta: { href: "/apply", label: () => "Start application" },
      };
  }
}

function statusTitle(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

function Row({
  icon: Icon,
  label,
  value,
  sub,
  href,
  muted,
  statusBadge,
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  href?: string;
  muted?: boolean;
  statusBadge?: string;
}) {
  const inner = (
    <div className="group flex items-center gap-4 border-b border-line py-5">
      <Icon
        className={`h-5 w-5 shrink-0 ${muted ? "text-ink-faint" : "text-phosphor-ink"}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
          {label}
        </p>
        <p
          className={`mt-1 text-base font-medium ${
            muted ? "text-ink-soft" : "text-ink"
          }`}
        >
          {value}
        </p>
        {sub && (
          <p className="mt-0.5 text-xs text-ink-soft truncate">{sub}</p>
        )}
      </div>
      {statusBadge && <StatusBadge status={statusBadge} />}
      {href && (
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink-soft" />
      )}
    </div>
  );
  if (href) {
    return (
      <Link href={href} className="press block hover:bg-wash">
        {inner}
      </Link>
    );
  }
  return inner;
}

async function countReferrals(code: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("referral_code", code);
    return count ?? 0;
  } catch {
    return 0;
  }
}
