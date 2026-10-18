import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, Megaphone } from "lucide-react";
import { requireUser, getProfile } from "@/lib/auth";
import { enrolledCohortIds, getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalTime } from "@/components/ui/local-time";
import { ChargePayButton } from "@/components/charge-pay-button";
import { loadStudentAssignments, type StudentItem } from "@/lib/assignments-server";
import { formatEastern } from "@/lib/assignments";
import { StatusChip } from "@/components/assignments/status-chip";
import { cohortWeek } from "@/lib/cohort-week";
import { getActiveChallenge, prizeHeadline, visibleSubmissionStatus } from "@/lib/challenges";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { InstallHint } from "@/components/app/install-hint";
import {
  AppHeader,
  AppBody,
  Section,
  Row,
  Empty,
  Alert,
  ActionLink,
} from "@/components/app/frame";
import type { Role } from "@/lib/types";
import { getCohortEvents, type AppEvent } from "@/lib/app-cache";
import { listInvitesForInvitee } from "@/lib/calls";
import type { CallInvite } from "@/lib/live";
import { homeNeeds, moreDueLabel, type NextUpItem } from "@/lib/needs-you";

export const metadata = { title: "Home · batch0" };
export const dynamic = "force-dynamic";

/**
 * The student's phone home screen.
 *
 * It answers three questions in order of how often they're asked: is anything
 * blocking me, what's due, and what's next on the calendar.
 * The founder pass and the certificate are once-a-cohort reads; they stay on
 * the /dashboard home.
 *
 * What's due and what's next are the /dashboard home's picks, from the same
 * function (homeNeeds in lib/needs-you.ts): owed work ranked so today's
 * deadline beats weeks-old late work, three of it and an "N more" row, and
 * the next 1:1 beside the next events. This screen used to take the first
 * three owed items off an oldest-first list and had no 1:1 at all.
 */
export default async function StudentAppHome() {
  // requireUser() is a LOCAL JWT verify (lib/auth.ts), not a database read, so
  // everything keyed on the user id can start immediately — before the profile,
  // the role, or the access rows have resolved. That is what makes the batch
  // below one wave instead of three.
  //
  // This screen used to cost five serial cross-region round trips: viewer,
  // then access rows, then the main batch, then the cohort-scoped batch, then
  // lesson progress. Each one is a full hop from the function to a
  // single-region Postgres, and on a phone on cellular they stacked up into the
  // dead second the app opened with. It is now two.
  const user = await requireUser();
  const admin = createAdminClient();
  const userId = user.id;
  const now = new Date();
  const nowIso = now.toISOString();

  // getStudentAccess needs a role, so it chains off the profile rather than
  // blocking the whole batch on it. Both are request-cached and were already
  // started by the layout, so in practice these resolve from cache.
  const profilePromise = getProfile();
  const accessPromise = profilePromise.then((p) =>
    getStudentAccess((p?.role as Role) ?? "student"),
  );
  // Assignments open at kickoff: before it (or before enrolling) there is
  // nothing to rank, and the page they'd link to is locked. Chained off the
  // request-cached access like the desktop home, so it still rides wave 1.
  // Explicit filters (enrolled cohort, published, released, audience), so the
  // service-role client reads exactly what the student's own would.
  const assignmentsPromise = accessPromise.then((a) =>
    a.enrolled && !a.preCohort
      ? loadStudentAssignments(admin, userId, { now })
      : { ready: true, items: [] as StudentItem[] },
  );

  // ---- Wave 1: everything keyed on the user alone ----
  const [
    profile,
    access,
    { data: enrollment },
    { data: charges },
    assignments,
    { count: unread },
    { data: allProgress },
    challenge,
    calls,
    eventCohorts,
  ] = await Promise.all([
    profilePromise,
    accessPromise,
    admin
      .from("enrollments")
      .select("id, cohort_id, cohort:cohorts(name, starts_on, ends_on)")
      .eq("user_id", userId)
      // enrollments is unique per (user_id, cohort_id), NOT per user — a
      // returning student has a row per cohort and a bare .maybeSingle()
      // throws PGRST116, which here silently cost them the week number and
      // the weekly lesson count. Newest enrollment wins.
      .order("enrolled_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Fees AND fines. The desktop home shows only fees; a fine is the harder
    // stop of the two (middleware locks the whole product behind it), so a
    // surface that hid it would leave someone staring at a redirect loop with
    // no explanation.
    admin
      .from("user_charges")
      .select("id, kind, amount_cents, description")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    assignmentsPromise,
    admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null),
    // Every lesson this student has finished, not just this week's.
    //
    // Fetching the whole set unfiltered looks wasteful and is the cheaper
    // shape: filtering to the current week would need the week's lesson ids,
    // which need the modules query, which needs the cohort — a third serial
    // round trip to save a few dozen rows on a table that is one row per
    // lesson a student has completed. The intersection happens in JS below.
    admin
      .from("lesson_progress")
      .select("lesson_id")
      .eq("user_id", userId)
      .not("completed_at", "is", null),
    // The open challenge, if there is one.
    getActiveChallenge(),
    // The student's 1:1s (filtered on their id). Booked for applicants and
    // pre-cohort students too, so it isn't gated on enrollment. A failed read
    // costs the row, never the screen.
    listInvitesForInvitee(userId).catch(() => [] as CallInvite[]),
    // Every cohort they're enrolled in, for the calendar: the `events read`
    // policy's line, and the same cache key /app/events uses. Off the access
    // rows the layout already read, so no round trip.
    enrolledCohortIds(),
  ]);

  const cohort = normalizeEmbed<{
    name: string | null;
    starts_on: string | null;
    ends_on: string | null;
  }>(enrollment?.cohort);
  // The cohort comes from the enrollment row above rather than from
  // getStudentAccess, so wave 2 depends only on wave 1 and never on the
  // request-cached access resolution finishing first.
  const cohortId =
    (enrollment?.cohort_id as string | null) ?? access.cohortId ?? null;
  const week = cohortWeek(cohort?.starts_on ?? access.cohortStartsOn);

  // ---- Wave 2: everything keyed on the cohort ----
  // These four genuinely cannot start earlier — each needs the cohort id or the
  // week number that wave 1 produced. Nothing after this awaits anything else.
  const [
    cohortEvents,
    { data: announcement },
    { data: weekLessons },
    { data: challengeEntry },
  ] = await Promise.all([
    // The same cached calendar /app/events reads (visibility as the
    // `events read` policy draws it).
    access.enrolled
      ? getCohortEvents({ cohortIds: eventCohorts }, nowIso)
      : Promise.resolve(null),
    cohortId && access.enrolled
      ? admin
          .from("announcements")
          .select("id, title, body, created_at")
          .or(`cohort_id.is.null,cohort_id.eq.${cohortId}`)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    cohortId && week
      ? admin
          .from("modules")
          .select("id, week, title, lessons(id)")
          .eq("cohort_id", cohortId)
          .eq("week", week)
      : Promise.resolve({ data: null }),
    challenge
      ? admin
          .from("challenge_submissions")
          .select("id, status")
          .eq("user_id", userId)
          .eq("challenge_id", challenge.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // What's due and what's next, picked exactly as the desktop home picks
  // them. Two calendar events here, one there: a phone has no other list of
  // them a tap away (Events lives under More).
  const needs = homeNeeds({
    access,
    assignments: assignments.items,
    events: cohortEvents?.upcoming ?? [],
    calls,
    now,
    eventLimit: 2,
    eventsHref: "/app/events",
  });
  const dueItems = needs.due.items;
  const nextUp = [...needs.open, ...needs.later];

  // "3 of 5 done" for the current week, intersected in memory against the full
  // progress set fetched in wave 1 — no third round trip.
  const doneLessonIds = new Set(
    (allProgress ?? []).map((p) => p.lesson_id as string),
  );
  const weekLessonIds = (weekLessons ?? []).flatMap((m) =>
    ((m.lessons ?? []) as Array<{ id: string }>).map((l) => l.id),
  );
  const weekDone = weekLessonIds.filter((id) => doneLessonIds.has(id)).length;
  const weekModuleTitle = (weekLessons ?? [])[0]?.title as string | undefined;

  const firstName = profile?.full_name?.split(" ")[0] || "there";
  const startLabel = fmtDateOnly(access.cohortStartsOn);

  const eyebrow = access.preCohort
    ? `Starts ${startLabel ?? "soon"}`
    : week
      ? `${cohort?.name ?? "Cohort"} · Week ${week}`
      : (cohort?.name ?? "batch0");

  return (
    <>
      <AppHeader
        title={`Hey, ${firstName}`}
        eyebrow={eyebrow}
        action={
          <Link
            href="/notifications"
            prefetch={false}
            aria-label={
              unread ? `Notifications, ${unread} unread` : "Notifications"
            }
            className="press relative rounded-lg border border-line px-2.5 py-2 text-ink-soft active:bg-wash"
          >
            <Megaphone className="h-4 w-4" />
            {!!unread && unread > 0 && (
              <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-phosphor px-1 text-center font-mono text-[9px] font-semibold leading-4 text-on-phosphor">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Link>
        }
      />

      <AppBody>
        {/* Blockers first. A pending fine is a hard middleware gate on the whole
            product, so it cannot be anywhere but the top of the first screen. */}
        {(charges ?? []).length > 0 && (
          <div className="space-y-3">
            {(charges ?? []).map((c) => (
              <Alert
                key={c.id}
                tone="warn"
                title={`${c.kind === "fine" ? "Fine" : "Fee"} due — $${(
                  c.amount_cents / 100
                ).toFixed(2)}`}
                action={<ChargePayButton chargeId={c.id} />}
              >
                {c.description}
                {c.kind === "fine" &&
                  " — the rest of batch0 stays locked until this is settled."}
              </Alert>
            ))}
          </div>
        )}

        {!access.enrolled ? (
          <>
            <Section title="Your application">
              <ApplicationState status={access.applicationStatus} />
            </Section>
            {nextUp.length > 0 && (
              <Section title="Next up">
                <NextUpList items={nextUp} />
              </Section>
            )}
          </>
        ) : access.preCohort ? (
          <>
            <Section title="Before day one">
              <Alert
                tone="info"
                title={`You're enrolled${cohort?.name ? ` in ${cohort.name}` : ""}.`}
                action={
                  <ActionLink href="/dashboard/kickoff" size="sm">
                    Kickoff details
                    <ArrowRight className="h-3.5 w-3.5" />
                  </ActionLink>
                }
              >
                The course and assignments open{startLabel ? ` ${startLabel}` : " at kickoff"}.
              </Alert>
            </Section>
            {/* Hosted rooms only (an orientation webinar), and the 1:1s the team
                books before kickoff: both open to a pre-cohort student. */}
            {nextUp.length > 0 && (
              <Section title="Next up">
                <NextUpList items={nextUp} />
              </Section>
            )}
          </>
        ) : (
          <>
            <Section title="This week" action={{ href: "/app/assignments", label: "Assignments" }}>
              {weekLessonIds.length === 0 && !challenge && dueItems.length === 0 ? (
                <Empty>Nothing due this week.</Empty>
              ) : (
              <div className="rounded-2xl border border-line">
                <div className="px-4">
                  {dueItems.map((i) => (
                    <Row
                      key={i.assignment.id}
                      label={i.assignment.title}
                      value={i.assignment.due_at ? `Due ${formatEastern(i.assignment.due_at)}` : undefined}
                      href={`/app/assignments/${i.assignment.id}`}
                      right={<StatusChip status={i.status} />}
                    />
                  ))}
                  {needs.due.more > 0 && (
                    <Row
                      label={moreDueLabel(needs.due.more)}
                      value="All assignments"
                      href="/app/assignments"
                      right={<ArrowRight className="h-4 w-4 shrink-0 text-ink-faint" />}
                    />
                  )}
                  {weekLessonIds.length > 0 && (
                    <Row
                      label={weekModuleTitle ?? `Week ${week} lessons`}
                      value={`${weekDone} of ${weekLessonIds.length} done`}
                      href="/app/course"
                      muted={weekDone === weekLessonIds.length}
                      right={
                        weekDone === weekLessonIds.length ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Circle className="h-4 w-4 shrink-0 text-ink-faint" />
                        )
                      }
                    />
                  )}
                  {challenge && (
                    <Row
                      label={challenge.title}
                      value={
                        challengeEntry
                          ? challengeEntry.status === "draft"
                            ? "Draft saved — finish & submit"
                            : (() => {
                                // Decisions stay private until winners are published.
                                const shown = visibleSubmissionStatus(challengeEntry.status, challenge.winnersPublished);
                                return shown === "funded"
                                  ? "Entered — winner"
                                  : shown === "rejected"
                                    ? "Entered — results are out"
                                    : shown === "shortlisted"
                                      ? "Entered — shortlisted"
                                      : "Entered";
                              })()
                          : (prizeHeadline(challenge) || "Open for entries")
                      }
                      href={
                        challengeEntry?.status === "draft"
                          ? `/challenges/${challenge.slug}/submit`
                          : `/challenges/${challenge.slug}`
                      }
                      muted={!!challengeEntry && challengeEntry.status !== "draft"}
                      right={
                        <div className="flex shrink-0 items-center gap-2">
                          {challenge.closesAt && (
                            <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                              <LocalTime value={challenge.closesAt} mode="date" />
                            </span>
                          )}
                          {challengeEntry && challengeEntry.status !== "draft" ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Circle className="h-4 w-4 text-ink-faint" />
                          )}
                        </div>
                      }
                    />
                  )}
                </div>
              </div>
              )}
            </Section>

            <Section title="Next up" action={{ href: "/app/events", label: "All" }}>
              {nextUp.length === 0 ? (
                <Empty>Nothing on the calendar yet.</Empty>
              ) : (
                <NextUpList items={nextUp} />
              )}
            </Section>
          </>
        )}

        {access.enrolled && announcement && (
          <Section
            title="Latest announcement"
            action={{ href: "/app/announcements", label: "All" }}
          >
            <Link
              href="/app/announcements"
              prefetch={false}
              className="press block rounded-2xl border border-line bg-wash px-5 py-4 active:scale-[0.99]"
            >
              <p className="text-[14px] font-medium leading-snug text-ink">
                {announcement.title}
              </p>
              <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-ink-soft">
                {announcement.body}
              </p>
              <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
                <LocalTime value={announcement.created_at} mode="datetime-short" />
              </p>
            </Link>
          </Section>
        )}

        <div className="mt-8">
          <InstallHint />
        </div>
      </AppBody>
    </>
  );
}

/**
 * The 1:1 and the events, one row each, open ones first. A call's room and
 * its list live under /dashboard/calls (More links it the same way); a hosted
 * event's room under /dashboard/events, an external one opens its link.
 */
function NextUpList({ items }: { items: NextUpItem<CallInvite, AppEvent>[] }) {
  return (
    <div className="rounded-2xl border border-line px-4 sm:px-5">
      {items.map((item) => {
        if (item.kind === "call") {
          const { invite, joinable } = item.call;
          return (
            <Row
              key={item.key}
              label={`1:1 with ${invite.hostName}`}
              value={`${invite.durationMinutes} min call`}
              href={joinable ? `/dashboard/calls/${invite.id}/live` : "/dashboard/calls"}
              prefetch={false}
              right={joinable ? <JoinPill /> : <When at={invite.startsAt} />}
            />
          );
        }
        const { event } = item;
        return (
          <Row
            key={item.key}
            label={event.title}
            value={event.live ? "Live now" : event.row.location || event.row.type.replace(/_/g, " ")}
            href={event.join?.href ?? event.href}
            external={event.join?.external}
            prefetch={false}
            right={event.join ? <JoinPill /> : <When at={event.startsAt} />}
          />
        );
      })}
    </div>
  );
}

function JoinPill() {
  return (
    <span className="shrink-0 rounded-md bg-phosphor px-2.5 py-1 text-[12px] font-semibold text-on-phosphor">
      Join
    </span>
  );
}

function When({ at }: { at: string }) {
  return (
    <span className="shrink-0 text-right font-mono text-[11px] leading-tight tabular-nums text-ink-faint">
      <LocalTime value={at} mode="datetime-short" />
    </span>
  );
}

/**
 * The pre-enrollment states, reduced to the one sentence and the one action
 * that matter. The desktop home writes a paragraph per status; on a phone the
 * only useful content is "what do I do now, if anything".
 */
function ApplicationState({ status }: { status: string | null }) {
  const map: Record<
    string,
    { title: string; body: string; cta?: { href: string; label: string } }
  > = {
    draft: {
      title: "Application in progress",
      body: "Pick up where you left off — it autosaves.",
      cta: { href: "/apply", label: "Continue" },
    },
    submitted: {
      title: "In review",
      body: "We're reading it. You'll get an email when there's a decision.",
    },
    waitlisted: {
      title: "Waitlisted",
      body: "Not a no. If a seat opens you're first in line.",
    },
    accepted: {
      title: "You're in",
      body: "Lock in your seat to unlock the cohort.",
      cta: { href: "/dashboard/accepted", label: "Pay to enroll" },
    },
    rejected: {
      title: "Not this cohort",
      body: "You can apply again when the next one opens.",
      cta: { href: "/apply", label: "Apply again" },
    },
  };
  const state = status
    ? map[status]
    : {
        title: "Not started",
        body: "Free to apply. Takes about twenty minutes.",
        cta: { href: "/apply", label: "Start application" },
      };
  if (!state) {
    return <Empty>Nothing to do here right now.</Empty>;
  }
  return (
    <Alert
      tone="info"
      title={state.title}
      action={
        state.cta && (
          <ActionLink href={state.cta.href} size="sm">
            {state.cta.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </ActionLink>
        )
      }
    >
      {state.body}
    </Alert>
  );
}

/** Supabase returns a to-one embed as an object or a single-element array. */
function normalizeEmbed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
}
