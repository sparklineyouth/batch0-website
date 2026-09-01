import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Mail, MessageSquare } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, formatWeekRange, lastNWeeks } from "@/lib/week";
import { getStudentProgress } from "@/lib/progress";
import {
  AppHeader,
  AppBody,
  Section,
  Row,
  Empty,
  Alert,
} from "@/components/app/frame";
import { DotRail, Meter, type RailCell } from "@/components/app/viz";

export const metadata = { title: "Person · Admin" };
export const dynamic = "force-dynamic";

/** How far back the cadence rail looks. Twelve weeks is a term. */
const RAIL_WEEKS = 12;

/**
 * Exact, unlike the overview's rounded formatter: this is what somebody owes,
 * and a $12.50 fine printed as "$13" is a number an admin would repeat out
 * loud. Copied rather than imported because the overview's `money` is local to
 * app/app/admin/page.tsx and rounds to whole dollars; the pair wants lifting
 * into lib/ the next time a third screen needs one.
 */
function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/**
 * One person, at a glance.
 *
 * The whole screen answers "should I be worried about this student, and how do I
 * reach them". So: where they are in the funnel, what they owe as one total,
 * how far through the material they are, who they build with, and their
 * check-in cadence over a term — plus a mailto and their Discord handle,
 * because the reason you looked them up is usually that you're about to
 * contact them.
 *
 * Every quantity on it is drawn, not listed. "Worried" is a judgement about a
 * shape — a run of missed weeks, a bar that stopped moving — and a column of
 * numbers makes the reader compute that shape themselves, on a phone, usually
 * while walking.
 *
 * It is read-only by design. Every mutation on a person (role changes, fee
 * waivers, account deletion) is consequential and irreversible-ish, and the
 * desktop record is one tap away. "Fully functional from the admin side" means
 * the time-sensitive decisions — application calls and announcements — not
 * every destructive button reachable from a thumb.
 */
export default async function AdminAppPerson({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const weekStart = isoWeekStart();
  const railWeeks = lastNWeeks(RAIL_WEEKS);

  // One wave, not three. Every read here is keyed on params.id and on nothing
  // the permission check produces, so the guard and all of the queries go out
  // together instead of guard -> profile -> the rest. The charges query is the
  // one exception: it is permission-dependent, so it is chained off the guard
  // rather than the batch, which still lets it overlap everything else.
  type Charge = {
    id: string;
    kind: string;
    amount_cents: number;
    description: string;
    status: string;
  };

  const guard = requirePermission("people.view");
  // Awaited inside so this settles to one shape rather than a union of a
  // PostgREST builder and a plain object, which Promise.all cannot destructure.
  const chargesPromise: Promise<Charge[]> = guard.then(async ({ caps: c }) => {
    if (!can(c, "charges.manage") && !can(c, "payments.view")) return [];
    const { data } = await admin
      .from("user_charges")
        .select("id, kind, amount_cents, description, status")
        .eq("user_id", params.id)
      // Paid rows come along only to give the outstanding total a denominator
      // — "owes $60 of $150 charged" is a different situation from "owes $60,
      // has never paid anything". Waived, cancelled and refunded stay out:
      // none of them is money the program collected, and folding them into
      // the paid side would flatter the bar.
        .in("status", ["pending", "paid"]);
    return (data ?? []) as Charge[];
  });

  const [
    viewer,
    personRes,
    appRes,
    enrollRes,
    memberRes,
    charges,
    checkinsRes,
    railRes,
    progress,
  ] = await Promise.all([
      guard,
      admin
        .from("profiles")
        .select("id, full_name, email, role, discord_username, created_at")
        .eq("id", params.id)
        .maybeSingle(),
      admin
        .from("applications")
        .select("id, status, submitted_at, cohort:cohorts(name)")
        .eq("user_id", params.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("enrollments")
        .select("enrolled_at, cohort:cohorts(name, starts_on)")
        .eq("user_id", params.id)
      // One row per cohort. Without this an admin opening a returning
      // student's record sees "Not enrolled" for someone plainly enrolled.
        .order("enrolled_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("team_members")
        .select("role, team:teams(id, name)")
        .eq("user_id", params.id)
        .limit(1)
        .maybeSingle(),
      chargesPromise,
    // Two reads of the same table, on purpose. This one is the prose: three
    // check-ins is as much free text as anyone reads on a phone.
      admin
        .from("student_checkins")
        .select("id, week_start, accomplished, blockers")
        .eq("user_id", params.id)
        .order("week_start", { ascending: false })
        .limit(3),
    // And this one is the shape. Three weeks was never enough to see a
    // pattern: a student who posted for eight weeks and stopped a month ago
    // renders as three blank weeks, which reads as "never engaged" rather
    // than "just fell off" — the opposite of the truth, on the one question
    // this screen exists to answer. Narrow select, because drawing twelve
    // squares does not need twelve blocks of free text.
      admin
        .from("student_checkins")
        .select("week_start")
        .eq("user_id", params.id)
        .gte("week_start", railWeeks[0].key)
      // `unique (user_id, week_start)` caps this at one row per Monday, so the
      // limit can never cut the window short — it is a ceiling, not a page.
        .order("week_start", { ascending: false })
        .limit(RAIL_WEEKS),
    // Not free, and worth it anyway. This fans out to eight more reads and
    // builds a second admin client, three of them unfiltered reads of the
    // content tables (lessons, flows, resources) — but they are small, they
    // overlap this wave rather than following it, and this is a one-person
    // detail screen behind a loading boundary, not a list. Without it the
    // screen cannot answer the question its own docblock promises, and the
    // desktop record stays the only place the answer lives. Same permission:
    // /admin/progress is gated on people.view too (lib/permissions.ts).
      getStudentProgress(params.id),
    ]);

  const { caps } = viewer;
  const person = personRes.data;
  const application = appRes.data;
  const enrollment = enrollRes.data;
  const membership = memberRes.data;
  const checkins = checkinsRes.data;

  // The batch above fetches unconditionally, so the 404 check moved down here.
  // It still runs before anything is rendered.
  if (!person) notFound();

  const appCohort = embed<{ name: string | null }>(application?.cohort);
  const enrollCohort = embed<{ name: string | null; starts_on: string | null }>(
    enrollment?.cohort,
  );
  const team = embed<{ id: string; name: string }>(membership?.team);

  // The rail's axis comes from the calendar, not from the query. A .gte()
  // returns rows only for weeks that HAVE a check-in, so a missed week is an
  // absent row rather than a false value — mapping the result straight to
  // cells would draw a three-cell rail for a nine-week gap.
  const posted = new Set(
    (railRes.data ?? []).map((r) => r.week_start as string),
  );
  const cells: RailCell[] = railWeeks.map((w) => ({
    key: w.key,
    label: w.label,
    // The current week is "future", not "miss": it hasn't ended, so it cannot
    // have been missed, and colouring it as a gap turns every Monday morning
    // into a false alarm. The Status row below answers this week outright.
    state: posted.has(w.key)
      ? "hit"
      : w.key === weekStart
        ? "future"
        : "miss",
  }));
  const closedWeeks = cells.filter((c) => c.state !== "future").length;
  const postedWeeks = cells.filter((c) => c.state === "hit").length;
  const checkedInThisWeek = posted.has(weekStart);

  // "Worried" has a threshold, and this is it: two weeks is where "busy" stops
  // being the explanation. Above it the number is a banner, below it a footnote.
  const idleDays = progress.idleDays;
  const idleTooLong = idleDays != null && idleDays > 14;
  const lastTouched = progress.stoppedAt
    ? `${progress.stoppedAt.label}${
        progress.stoppedAt.detail ? ` — ${progress.stoppedAt.detail}` : ""
      }`
    : null;

  const owed = charges.filter((c) => c.status === "pending");
  const settled = charges.filter((c) => c.status === "paid");
  const sum = (list: Charge[]) =>
    list.reduce((total, c) => total + c.amount_cents, 0);
  const owedCents = sum(owed);
  const settledCents = sum(settled);

  return (
    <>
      <AppHeader
        title={(person.full_name as string) || "No name"}
        eyebrow={(person.role as string) ?? "student"}
        action={
          <Link
            href="/app/admin/people"
            prefetch={false}
            aria-label="Back to people"
            className="press inline-flex h-11 w-11 items-center justify-center rounded-lg border border-line text-ink-soft active:bg-wash"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        }
      />
      <AppBody>
        {/* Contact first: it's why you're here. */}
        <div className="flex gap-2">
          <a
            href={`mailto:${person.email}`}
            className="press flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line bg-wash text-[13px] font-medium text-ink active:scale-[0.99]"
          >
            <Mail className="h-4 w-4" />
            Email
          </a>
          {!!person.discord_username && (
            <div className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line bg-wash px-3 text-[13px] text-ink-soft">
              <MessageSquare className="h-4 w-4 shrink-0" />
              <span className="truncate font-mono text-[12px]">
                {person.discord_username as string}
              </span>
            </div>
          )}
        </div>
        <p className="mt-2 truncate text-center font-mono text-[11px] text-ink-faint">
          {person.email as string}
        </p>

        {/* Headed "Charges", not "Owes": the banner right below it already
            says "Owes $60.00", and a heading that repeats it reads as two
            separate facts. */}
        {owed.length > 0 && (
          <Section title="Charges">
            {/* The total, first and largest. The list underneath is every
                pending charge with its amount on the right and no sum
                anywhere, which made the one question an admin actually asks —
                how much does this person owe me — a mental addition performed
                while scrolling. */}
            <Alert tone="warn" title={`Owes ${money(owedCents)}`}>
              {settledCents > 0 ? (
                <Meter
                  label="Charges settled"
                  // Whole dollars, not cents: Meter prints its own value/max
                  // beside the track, and "4000/6000" next to a $60 total
                  // reads as a different number entirely. The caption carries
                  // the exact figures.
                  value={Math.round(settledCents / 100)}
                  max={Math.round((settledCents + owedCents) / 100)}
                  caption={`${money(settledCents)} settled of ${money(
                    settledCents + owedCents,
                  )} charged`}
                  tone="warn"
                />
              ) : (
                `${owed.length === 1 ? "One charge" : `${owed.length} charges`} outstanding, nothing paid yet.`
              )}
            </Alert>
            <div className="mt-3 rounded-2xl border border-line px-4 sm:px-5">
              {/* Only the pending rows: the value line below hardcodes
                  "pending", and the paid rows exist here for the ratio. */}
              {owed.map((c) => (
                <Row
                  key={c.id as string}
                  label={c.description as string}
                  value={`${c.kind === "fine" ? "Fine" : "Fee"} · pending`}
                  right={
                    <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                      ${((c.amount_cents as number) / 100).toFixed(2)}
                    </span>
                  }
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Status">
          <div className="rounded-2xl border border-line px-4 sm:px-5">
            <Row
              label="Application"
              value={
                appCohort?.name ??
                (application ? "No cohort assigned" : "Never applied")
              }
              // Gated on the DESTINATION's permission, not this page's. A role
              // with people.view but not applications.view would otherwise tap
              // through and be bounced to /admin by the route guard — a link
              // that looks live and silently throws you somewhere else is worse
              // than plain text.
              href={
                application && can(caps, "applications.view")
                  ? `/admin/applications/${application.id}`
                  : undefined
              }
              right={
                application ? (
                  <StatusBadge status={application.status as string} />
                ) : undefined
              }
            />
            <Row
              label="Enrollment"
              value={
                enrollment
                  ? (enrollCohort?.name ?? "Enrolled")
                  : "Not enrolled"
              }
              muted={!enrollment}
              right={
                enrollment ? (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    <LocalTime value={enrollment.enrolled_at as string} mode="date" />
                  </span>
                ) : undefined
              }
            />
            <Row
              label="Team"
              value={team ? team.name : "No team"}
              muted={!team}
              // Same reasoning as the Application row above: /admin/teams
              // requires teams.manage.
              href={
                team && can(caps, "teams.manage")
                  ? `/admin/teams/${team.id}`
                  : undefined
              }
            />
            <Row
              label="This week's check-in"
              value={checkedInThisWeek ? "Posted" : "Missing"}
              meta={formatWeekRange(weekStart)}
              muted={!checkedInThisWeek}
            />
          </div>
        </Section>

        {/* Where they are in the material, as three ratios rather than three
            counts. "12 lessons done" means nothing without the course length,
            and the course length is not something anyone carries in their
            head. */}
        <Section
          title="Progress"
          // Suppressed while the banner is up: the same number in a header and
          // in an alert three lines apart reads as two different facts.
          action={
            lastTouched && !idleTooLong ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                {idleDays === 0 ? "active today" : `${idleDays}d idle`}
              </span>
            ) : undefined
          }
        >
          {lastTouched == null ? (
            <Empty>Hasn&apos;t opened a lesson, flow or resource yet.</Empty>
          ) : (
            <>
              {idleTooLong && (
                <div className="mb-3">
                  <Alert
                    tone="warn"
                    title={`Nothing touched in ${idleDays} days`}
                  >
                    Last: {lastTouched}
                  </Alert>
                </div>
              )}
              <div className="rounded-2xl border border-line px-4 sm:px-5">
                <Row
                  label="Course"
                  // `below`, not `meta`: meta renders inside a truncating <p>,
                  // and a flex track in there is invalid nesting.
                  below={
                    <Meter
                      label="Lessons finished"
                      value={progress.course.done}
                      max={progress.course.total}
                      caption={
                        progress.course.inProgress > 0
                          ? `${progress.course.inProgress} started`
                          : undefined
                      }
                    />
                  }
                />
                <Row
                  label="Pre-cohort flows"
                  below={
                    <Meter
                      label="Flows finished"
                      value={progress.flows.done}
                      max={progress.flows.total}
                      caption={
                        progress.flows.inProgress > 0
                          ? `${progress.flows.inProgress} started`
                          : undefined
                      }
                    />
                  }
                />
                <Row
                  label="Resources"
                  below={
                    <Meter
                      label="Resources opened"
                      value={progress.resources.done}
                      max={progress.resources.total}
                    />
                  }
                />
              </div>
              {!idleTooLong && (
                <p className="mt-2.5 text-[11.5px] leading-snug text-ink-faint">
                  Last: {lastTouched}
                </p>
              )}
            </>
          )}
        </Section>

        <Section title="Check-ins">
          {/* The rail first, the words second: the rail answers "should I be
              worried", the three cards answer "about what". A student with a
              long history and a recent gap is the case this exists for, and it
              is invisible in three prose cards. */}
          {(checkins ?? []).length > 0 && (
            <div className="mb-5">
              <DotRail
                label="Weekly check-ins"
                cells={cells}
                caption={`${postedWeeks} of the last ${closedWeeks} weeks`}
                tone={postedWeeks === 0 ? "warn" : "default"}
              />
            </div>
          )}
          {(checkins ?? []).length === 0 ? (
            <Empty>Never posted a check-in.</Empty>
          ) : (
            <div className="space-y-2.5">
              {(checkins ?? []).map((c) => (
                <div
                  key={c.id as string}
                  className="rounded-2xl border border-line bg-wash px-5 py-4"
                >
                  <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
                    {formatWeekRange(c.week_start as string)}
                  </p>
                  {!!c.accomplished && (
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">
                      {c.accomplished as string}
                    </p>
                  )}
                  {!!c.blockers && (
                    <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-[13px] leading-relaxed text-amber-700 dark:text-amber-300">
                      Blocked: {c.blockers as string}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* A footnote now, not a button. This was a full-width 44px control
            styled exactly like Email, which made the visually heaviest thing
            on the screen a one-way trip into three desktop <table>s — and it
            was heavy because the screen was thin. Money, cadence and progress
            are all above it now, so what is left over there is the
            record-keeping this page deliberately does not do: waivers, role
            changes, deletion. */}
        <div className="mt-9 flex justify-center">
          <Link
            href={`/admin/students/${person.id}`}
            prefetch={false}
            className="press inline-flex min-h-11 items-center gap-1.5 text-[13px] text-ink-faint"
          >
            Open the desktop record
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </AppBody>
    </>
  );
}

/** Supabase returns a to-one embed as an object or a single-element array. */
function embed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
}
