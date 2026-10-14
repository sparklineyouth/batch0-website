import { Video, MapPin } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { getCohortEvents } from "@/lib/app-cache";
import { LocalTime } from "@/components/ui/local-time";
import { studentEventStatus } from "@/lib/event-form";
import { isHostedOnBatch0 } from "@/lib/webinars";
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
  webinar: "Webinar",
  other: "Event",
};

/**
 * The calendar, upcoming-first, with a one-tap Join: the batch0 room for a
 * hosted event once it opens (15 minutes before, or when a host goes live),
 * the pasted link for an external one. Past events keep their recording link.
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
            Pay for your seat to see them.
          </Alert>
        </AppBody>
      </>
    );
  }

  const nowIso = new Date().toISOString();

  // Cached (lib/app-cache.ts): the calendar is staff-authored and changes a few
  // times a cohort, so it is shared across everyone in that cohort for a minute
  // — and the prefetcher has usually warmed it before this screen is opened.
  const { upcoming, past } = await getCohortEvents(
    { cohortId: access.cohortId },
    nowIso,
  );
  const now = new Date(nowIso);
  const statusOf = (e: (typeof upcoming)[number]) =>
    studentEventStatus(
      {
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        liveStartedAt: e.live_started_at,
        liveEndedAt: e.live_ended_at,
      },
      now,
    );
  const ahead = upcoming
    .map((e) => ({ e, s: statusOf(e) }))
    .filter((x) => x.s === "live" || x.s === "open" || x.s === "upcoming")
    .sort((a, b) => Number(b.s === "live") - Number(a.s === "live"));

  return (
    <>
      <AppHeader title="Events" eyebrow="Live sessions, Demo Day" />
      <AppBody>
        <Section title="Upcoming">
          {ahead.length === 0 ? (
            <Empty>Nothing scheduled right now.</Empty>
          ) : (
            <div className="space-y-2.5">
              {ahead.map(({ e, s }) => (
                <div
                  key={e.id as string}
                  className="rounded-2xl border border-line bg-wash px-5 py-4"
                >
                  <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-phosphor-ink">
                    {s === "live" ? "Live now · " : ""}
                    {TYPE_LABEL[e.type as string] ?? "Event"}
                  </p>
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
                  {isHostedOnBatch0(e.live_mode) ? (
                    (s === "live" || s === "open") && (
                      <a
                        href={`/dashboard/events/${e.id}/live`}
                        className="press mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-phosphor px-3.5 text-[13px] font-semibold leading-none text-on-phosphor active:scale-[0.98]"
                      >
                        <Video className="h-3.5 w-3.5" />
                        Join
                      </a>
                    )
                  ) : (
                    !!e.zoom_url && (
                      <a
                        href={e.zoom_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="press mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-phosphor px-3.5 text-[13px] font-semibold leading-none text-on-phosphor active:scale-[0.98]"
                      >
                        <Video className="h-3.5 w-3.5" />
                        Join
                      </a>
                    )
                  )}
                </div>
              ))}
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
