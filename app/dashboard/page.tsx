import Link from "next/link";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, getProfile } from "@/lib/auth";
import { LocalTime } from "@/components/ui/local-time";
import { ButtonLink } from "@/components/ui/button";
import { FounderPassCard } from "./founder-pass-card";
import { getPassForUser } from "@/lib/founder-pass";
import { ChargePayButton } from "@/components/charge-pay-button";
import { StatusChip } from "@/components/assignments/status-chip";
import { getStudentAccess, type StudentAccess } from "@/lib/access";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { cohortWeek } from "@/lib/cohort-week";
import { loadStudentAssignments, type StudentItem } from "@/lib/assignments-server";
import { formatEastern } from "@/lib/assignments";
import { listInvitesForInvitee } from "@/lib/calls";
import {
  HOME_EVENT_COLUMNS,
  dueSoon,
  pickNextCall,
  pickNextEvent,
  type HomeEventRow,
} from "@/lib/needs-you";
import { getSiteConfig } from "@/lib/site-config";
import type { Role } from "@/lib/types";
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  ClipboardList,
  Ticket,
  Video,
} from "lucide-react";

const DAY_MS = 24 * 60 * 60_000;

export default async function DashboardHome() {
  const user = await requireUser();
  const supabase = await createClient();
  const admin = createAdminClient();
  const now = new Date();

  // Profile and access are request-cached (the layout resolved them). Reads
  // that need access chain off it so everything lands in one wave. Every read
  // here tolerates migrations 0093–0100 being absent: assignments come back
  // `ready: false`, and the event columns all predate them.
  const profilePromise = getProfile();
  const accessPromise = profilePromise.then((p) =>
    getStudentAccess((p?.role as Role) ?? "student"),
  );
  const assignmentsPromise = accessPromise.then((a) =>
    a.enrolled && !a.preCohort
      ? loadStudentAssignments(supabase, user.id, { now })
      : { ready: true, items: [] as StudentItem[] },
  );
  // Upcoming plus anything that started in the last day (it may still be on).
  // RLS decides which events this viewer may see.
  const eventsPromise = accessPromise.then(async (a) => {
    if (!a.enrolled && !a.demoDayTicket) return [] as HomeEventRow[];
    const { data } = await supabase
      .from("events")
      .select(HOME_EVENT_COLUMNS)
      .gte("starts_at", new Date(now.getTime() - DAY_MS).toISOString())
      .order("starts_at", { ascending: true })
      .limit(20);
    return (data ?? []) as HomeEventRow[];
  });

  const [
    profile,
    access,
    siteConfig,
    { data: app },
    { data: enrollment },
    { data: charges },
    { data: certificate },
    founderPass,
    assignments,
    events,
    calls,
  ] = await Promise.all([
    profilePromise,
    accessPromise,
    getSiteConfig(),
    supabase
      .from("applications")
      .select("status")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Newest enrollment: a returning student has one row per cohort.
    supabase
      .from("enrollments")
      .select("cohort:cohorts(name, starts_on, ends_on)")
      .eq("user_id", user.id)
      .order("enrolled_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // A pending fine also hard-blocks in middleware; listing it is harmless.
    supabase
      .from("user_charges")
      .select("id, kind, amount_cents, description")
      .eq("user_id", user.id)
      .in("kind", ["fee", "fine"])
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("certificates")
      .select("code")
      .eq("user_id", user.id)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getPassForUser(admin, user.id),
    assignmentsPromise,
    eventsPromise,
    listInvitesForInvitee(user.id).catch(() => []),
  ]);

  const price = siteConfig.derived.priceLabel;
  const startDate = fmtDateOnly(access.cohortStartsOn);
  const cohortRaw = (enrollment?.cohort ?? null) as unknown;
  const cohort = (Array.isArray(cohortRaw) ? (cohortRaw[0] ?? null) : cohortRaw) as CohortDates | null;
  const hero = heroFor(app?.status, access, {
    startDate,
    price,
    cohortLabel: cohortLabel(cohort, now),
  });
  const greeting = profile?.full_name?.split(" ")[0] || "there";

  // ---- Needs you: money first, then anything open now, then what's due ----
  const rows: NeedsRow[] = [];
  for (const c of charges ?? []) {
    rows.push({
      key: `charge-${c.id}`,
      icon: AlertCircle,
      warn: true,
      title: `${c.kind === "fine" ? "Fine" : "Fee"}: ${c.description}`,
      meta: `$${(c.amount_cents / 100).toFixed(2)} due`,
      right: <ChargePayButton chargeId={c.id} />,
    });
  }
  const event = pickNextEvent(events, now, { preCohort: access.preCohort });
  const call = pickNextCall(calls, now);
  const eventRow: NeedsRow | null = event && {
    key: `event-${event.id}`,
    icon: CalendarDays,
    title: event.title,
    meta: event.live ? "Live now" : <LocalTime value={event.startsAt} mode="datetime-short" />,
    href: event.join?.href ?? event.href,
    external: event.join?.external,
    right: event.join ? <JoinPill /> : null,
  };
  const callRow: NeedsRow | null = call && {
    key: `call-${call.invite.id}`,
    icon: Video,
    title: `1:1 with ${call.invite.hostName}`,
    meta: <LocalTime value={call.invite.startsAt} mode="datetime-short" />,
    href: call.joinable ? `/dashboard/calls/${call.invite.id}/live` : "/dashboard/calls",
    right: call.joinable ? <JoinPill /> : null,
  };
  if (callRow && call?.joinable) rows.push(callRow);
  if (eventRow && event?.join) rows.push(eventRow);
  for (const { assignment: a, status } of dueSoon(assignments.items, now)) {
    rows.push({
      key: `assignment-${a.id}`,
      icon: ClipboardList,
      title: a.title,
      meta: a.due_at ? `Due ${formatEastern(a.due_at)}` : "No due date",
      href: `/dashboard/assignments/${a.id}`,
      right: <StatusChip status={status} />,
    });
  }
  if (eventRow && !event?.join) rows.push(eventRow);
  if (callRow && !call?.joinable) rows.push(callRow);
  if (!event && access.demoDayTicket && !access.enrolled) {
    rows.push({
      key: "demo-day-ticket",
      icon: Ticket,
      title: "Demo Day ticket confirmed",
      meta: "Details under Events",
      href: "/dashboard/events",
    });
  }
  const showNeeds = rows.length > 0 || access.enrolled;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="border-b border-line pb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          {hero.label}
        </p>
        <h1 className="mt-3 text-4xl md:text-5xl font-bold tracking-[-0.02em] text-ink">
          Welcome, {greeting}.
        </h1>
        {hero.lede && <p className="mt-3 text-[15px] text-ink-soft">{hero.lede}</p>}
        {hero.cta && (
          <div className="mt-6">
            <ButtonLink href={hero.cta.href}>
              {hero.cta.label}
              <ArrowRight className="h-4 w-4 shrink-0" />
            </ButtonLink>
          </div>
        )}
      </div>

      {showNeeds && (
        <section className="mt-8" aria-labelledby="needs-you">
          <h2
            id="needs-you"
            className="font-mono text-xs uppercase tracking-wider text-ink-faint"
          >
            Needs you
          </h2>
          {rows.length === 0 ? (
            <p className="mt-3 border-y border-line py-6 text-sm text-ink-soft">
              Nothing right now.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {rows.map((r) => (
                <li key={r.key}>
                  <NeedsItem row={r} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {founderPass && (
        <div className="mt-10">
          <FounderPassCard serial={founderPass.serial} batch={founderPass.batch} />
        </div>
      )}

      {certificate && (
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 rounded-md border border-phosphor/30 bg-phosphor/[0.04] px-5 py-4">
          <p className="text-sm text-ink">You graduated.</p>
          <ButtonLink href={`/verify/${certificate.code}`} size="sm">
            View certificate
            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
          </ButtonLink>
        </div>
      )}
    </div>
  );
}

type CohortDates = { name: string | null; starts_on: string | null; ends_on: string | null };

type NeedsRow = {
  key: string;
  icon: typeof AlertCircle;
  warn?: boolean;
  title: string;
  meta: ReactNode;
  /** The whole row links here. Rows whose `right` is its own control (Pay) have none. */
  href?: string;
  external?: boolean;
  right?: ReactNode;
};

function NeedsItem({ row }: { row: NeedsRow }) {
  const Icon = row.icon;
  const body = (
    <>
      <Icon
        className={`h-4 w-4 shrink-0 ${
          row.warn ? "text-amber-700 dark:text-amber-300" : "text-phosphor-ink"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium text-ink">{row.title}</p>
        <p className="mt-0.5 text-xs text-ink-faint">{row.meta}</p>
      </div>
      {row.right}
    </>
  );
  const cls = "flex items-center gap-4 py-4";
  if (!row.href) return <div className={cls}>{body}</div>;
  if (row.external) {
    return (
      <a
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`press ${cls} hover:bg-wash`}
      >
        {body}
      </a>
    );
  }
  return (
    <Link href={row.href} prefetch={false} className={`press ${cls} hover:bg-wash`}>
      {body}
    </Link>
  );
}

function JoinPill() {
  return (
    <span className="shrink-0 rounded-md bg-phosphor px-2.5 py-1 text-xs font-semibold text-on-phosphor">
      Join
    </span>
  );
}

/** "Fall 2026 · Week 6" while the cohort runs; the name alone after it ends. */
function cohortLabel(c: CohortDates | null, now: Date): string | null {
  if (!c?.name) return null;
  const over = c.ends_on ? now.toISOString().slice(0, 10) > c.ends_on : false;
  const week = over ? null : cohortWeek(c.starts_on, now);
  return week ? `${c.name} · Week ${week}` : c.name;
}

type Hero = {
  label: string;
  lede: string | null;
  cta: { href: string; label: string } | null;
};

function heroFor(
  status: string | null | undefined,
  access: StudentAccess,
  ctx: { startDate: string | null; price: string; cohortLabel: string | null },
): Hero {
  const pay = { href: "/dashboard/accepted", label: `Pay ${ctx.price} to enroll` };
  // Pre-cohort wins whatever the newest application row says (an
  // admin-enrolled student may have none, or a draft for the next cycle).
  if (access.preCohort) {
    if (!access.enrolled && status === "accepted") {
      return {
        label: "Accepted",
        lede: ctx.startDate ? `The cohort starts ${ctx.startDate}.` : null,
        cta: pay,
      };
    }
    return {
      label: "Enrolled",
      lede: `${access.cohortName ?? "Your cohort"} starts ${ctx.startDate ?? "soon"}.`,
      cta: { href: "/dashboard/kickoff", label: "Kickoff details" },
    };
  }
  if (access.enrolled) {
    return {
      label: ctx.cohortLabel ?? "Enrolled",
      lede: null,
      cta: { href: "/dashboard/course", label: "Open course" },
    };
  }
  switch (status) {
    case "draft":
      return {
        label: "Application · Draft",
        lede: "Every answer is saved.",
        cta: { href: "/apply", label: "Continue application" },
      };
    case "submitted":
      return {
        label: "Application · In review",
        lede: "We'll email you a decision.",
        cta: { href: "/dashboard/application", label: "View application" },
      };
    case "waitlisted":
      return {
        label: "Application · Waitlisted",
        lede: "We'll email you if a seat opens.",
        cta: null,
      };
    case "accepted":
      return { label: "Accepted", lede: "Lock in your seat.", cta: pay };
    case "rejected":
      return {
        label: "Application · Closed",
        lede: "Not this cohort.",
        cta: { href: "/apply", label: "Apply to another cohort" },
      };
    default:
      return {
        label: "Get started",
        lede: "Turn an idea into a pitch.",
        cta: { href: "/apply", label: "Start application" },
      };
  }
}
