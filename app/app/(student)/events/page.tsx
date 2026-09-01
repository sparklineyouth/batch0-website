import { Video, MapPin } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { getCohortEvents } from "@/lib/app-cache";
import { LocalTime } from "@/components/ui/local-time";
import {
  AppHeader,
  AppBody,
  Section,
  Empty,
  Row,
  Alert,
} from "@/components/app/frame";
import type { Role } from "@/lib/types";

export const metadata = { title: "Events · batch0" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  demo_day: "Demo Day",
  office_hours: "Office hours",
  workshop: "Workshop",
  other: "Event",
};

/**
 * Time-to-event, as a duration rather than a calendar day.
 *
 * "Tomorrow" / "Friday" would group this list better, but a calendar day is a
 * timezone concept and this runs on the server — which is UTC on Vercel. A 7pm
 * ET event falls on the *next* UTC day, so day headings computed here would
 * confidently file tonight's office hours under tomorrow for every reader east
 * or west of the machine. That is precisely the bug components/ui/local-time.tsx
 * exists to avoid, and the fix there was to move formatting to the client.
 *
 * A duration has no such problem: forty minutes is forty minutes in every
 * timezone. So this is the one proximity signal a server component can render
 * honestly, and it is the thing the screen was actually missing — twenty cards
 * that looked identical whether the event started in forty minutes or in six
 * weeks.
 */
function untilLabel(startsAt: string, nowMs: number): string | null {
  const ms = new Date(startsAt).getTime() - nowMs;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "starting now";
  // Floor, never round. Rounding to the nearest bucket overstates the time
  // left — 1h31m would print "in 2 hours" — and on the one screen whose job is
  // getting you into a call on time, the two errors are not symmetric: telling
  // someone they have longer than they do makes them late, telling them less
  // makes them early. Each branch is entered only above its own threshold, so
  // flooring can never produce "in 0 min".
  const min = Math.max(1, Math.floor(ms / 60000));
  if (min < 60) return `in ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr} hour${hr === 1 ? "" : "s"}`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `in ${day} day${day === 1 ? "" : "s"}`;
  return `in ${Math.floor(day / 7)} weeks`;
}

/**
 * The calendar, upcoming-first.
 *
 * The join link is the entire point of opening this on a phone — you are
 * standing up, it starts in two minutes, and you need one tap. So it renders as
 * a real button on every upcoming event rather than something you reach by
 * opening a detail view.
 *
 * Past events keep their recording link and nothing else, which is the only
 * reason to look backwards here.
 */
export default async function StudentAppEvents() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);

  // ENROLLMENT GATE — must stay above any query.
  //
  // The app shell admits anyone with a live application (lib/app-eligibility.ts),
  // which is deliberate: a waitlisted applicant should be able to open the app.
  // But events are enrolled-only content, and every read here goes through
  // createAdminClient(), which uses the service role and therefore BYPASSES the
  // `events read` RLS policy that would otherwise have enforced this. RLS is not
  // a backstop on this code path; this check is the only thing standing between
  // an unpaid applicant and a cohort's live Zoom join links.
  //
  // /dashboard/events draws the same line with <LockedFeature>. A phone surface
  // must never be more permissive than the page it mirrors.
  //
  // Staff resolve as enrolled (lib/access.ts), so previewing still works.
  if (!access.enrolled) {
    return (
      <>
        <AppHeader title="Events" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="Events unlock at enrollment.">
            Office hours, workshops and demo day show up here once your seat is
            paid for.
          </Alert>
        </AppBody>
      </>
    );
  }

  const nowIso = new Date().toISOString();
  // Same instant the query splits upcoming from past on. Deriving it rather
  // than calling Date.now() again means a card can never say "starting now"
  // about an event the query has already filed under past.
  const nowMs = Date.parse(nowIso);

  // Cached (lib/app-cache.ts): the calendar is staff-authored and changes a few
  // times a cohort, so it is shared across everyone in that cohort for a minute
  // — and the prefetcher has usually warmed it before this screen is opened.
  const { upcoming, past } = await getCohortEvents(
    { cohortId: access.cohortId },
    nowIso,
  );

  return (
    <>
      <AppHeader title="Events" eyebrow="Office hours, workshops, demo day" />
      <AppBody>
        <Section title="Upcoming">
          {(upcoming ?? []).length === 0 ? (
            <Empty>Nothing scheduled right now.</Empty>
          ) : (
            <div className="space-y-2.5">
              {(upcoming ?? []).map((e, i) => {
                const until = untilLabel(e.starts_at as string, nowMs);
                // The soonest event is the one you opened this screen for, so
                // it gets the Alert `info` tone from frame.tsx verbatim —
                // border-phosphor/30 + bg-phosphor/[0.06]. Copying the exact
                // values rather than eyeballing a near-miss: a second
                // almost-identical phosphor border reads as a rendering bug
                // when the two sit on the same screen.
                const next = i === 0;
                return (
                  <div
                    key={e.id as string}
                    className={`rounded-2xl border px-5 py-4 ${
                      next
                        ? "border-phosphor/30 bg-phosphor/[0.06]"
                        : "border-line bg-wash"
                    }`}
                  >
                    {/* Type on the left, proximity on the right, both in the
                        eyebrow. Keeping the countdown up here means "when" sits
                        at the same height on every card, so the list scans
                        vertically instead of card by card. */}
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-phosphor-ink">
                        {TYPE_LABEL[e.type as string] ?? "Event"}
                      </p>
                      {until && (
                        <p
                          className={`shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.16em] ${
                            next ? "text-phosphor-ink" : "text-ink-faint"
                          }`}
                        >
                          {until}
                        </p>
                      )}
                    </div>
                    <p className="mt-1.5 text-[15px] leading-snug text-ink">
                      {e.title as string}
                    </p>
                    <p className="mt-1.5 font-mono text-[12px] tabular-nums text-ink-soft">
                      <LocalTime value={e.starts_at as string} mode="datetime" />
                    </p>
                    {!!e.location && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-faint">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {e.location as string}
                      </p>
                    )}
                    {/* `description` was already being selected and thrown
                        away — pure payload on the worst connection. It sits
                        below the fixed what/when/where block rather than under
                        the title so a two-line blurb on one card can't shift
                        the timestamp on the next one out of alignment. */}
                    {!!e.description && (
                      <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
                        {e.description as string}
                      </p>
                    )}
                    {!!e.zoom_url && (
                      // h-11 and full width, not h-9. 36px is the density
                      // globals.css concedes to admin tables; this is the one
                      // time-critical tap a student makes, on the screen whose
                      // own doc comment says you are standing up and it starts
                      // in two minutes. The card IS the event, so the whole
                      // bottom edge of it is the join.
                      //
                      // Deliberately not <ActionLink>: that is a next/link
                      // <Link> with no target/rel, and a same-window Zoom
                      // navigation out of a standalone PWA replaces the app
                      // with no back button — worse than a small target.
                      <a
                        href={e.zoom_url as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="press mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-phosphor px-3.5 text-[14px] font-semibold leading-none text-on-phosphor active:scale-[0.98]"
                      >
                        <Video className="h-3.5 w-3.5" />
                        Join
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {(past ?? []).some((e) => e.recording_url) && (
          <Section title="Recent recordings">
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {(past ?? [])
                .filter((e) => e.recording_url)
                .map((e) => (
                  <Row
                    key={e.id as string}
                    label={e.title as string}
                    meta={<LocalTime value={e.starts_at as string} mode="date" />}
                    href={e.recording_url as string}
                    external
                    right={
                      <Video className="h-[18px] w-[18px] shrink-0 text-ink-faint" />
                    }
                  />
                ))}
            </div>
          </Section>
        )}
      </AppBody>
    </>
  );
}
