import { Video, MapPin } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalTime } from "@/components/ui/local-time";
import { AppHeader, AppBody, Section, Empty } from "@/components/app/frame";
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
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Cohort-scoped events plus the global ones, matching what /dashboard/events
  // shows. A PostgREST builder is single-use, so each query builds its own
  // rather than sharing one and having the second inherit the first's filters.
  const scoped = () => {
    const q = admin
      .from("events")
      .select(
        "id, title, type, description, starts_at, location, zoom_url, recording_url",
      )
      .in("visibility", ["enrolled", "public"]);
    return access.cohortId
      ? q.or(`cohort_id.is.null,cohort_id.eq.${access.cohortId}`)
      : q.is("cohort_id", null);
  };

  const [{ data: upcoming }, { data: past }] = await Promise.all([
    scoped()
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(20),
    // Only the recent past, and only enough of it to find last week's
    // recording — the archive is not a phone surface.
    scoped()
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(5),
  ]);

  return (
    <>
      <AppHeader title="Events" eyebrow="Office hours, workshops, demo day" />
      <AppBody>
        <Section title="Upcoming">
          {(upcoming ?? []).length === 0 ? (
            <Empty>Nothing scheduled right now.</Empty>
          ) : (
            <div className="space-y-2.5">
              {(upcoming ?? []).map((e) => (
                <div
                  key={e.id as string}
                  className="rounded-2xl border border-line bg-wash px-5 py-4"
                >
                  <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-phosphor-ink">
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
                  {!!e.zoom_url && (
                    <a
                      href={e.zoom_url as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="press mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-phosphor px-3.5 text-[13px] font-semibold leading-none text-on-phosphor active:scale-[0.98]"
                    >
                      <Video className="h-3.5 w-3.5" />
                      Join
                    </a>
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
                  <a
                    key={e.id as string}
                    href={e.recording_url as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="press -mx-2 flex min-h-[54px] items-center gap-3 border-b border-line px-2 last:border-0 active:bg-wash"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] text-ink">
                        {e.title as string}
                      </p>
                      <p className="mt-1 font-mono text-[11px] tabular-nums text-ink-faint">
                        <LocalTime value={e.starts_at as string} mode="date" />
                      </p>
                    </div>
                    <Video className="h-4 w-4 shrink-0 text-ink-faint" />
                  </a>
                ))}
            </div>
          </Section>
        )}
      </AppBody>
    </>
  );
}
