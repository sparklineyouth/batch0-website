import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Lock,
  PlayCircle,
} from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { cohortWeek } from "@/lib/cohort-week";
import { getSyllabus, type SyllabusModule } from "@/lib/app-cache";
import { fmtDateOnly } from "@/lib/pre-cohort";
import {
  AppHeader,
  AppBody,
  Empty,
  Alert,
  Row,
  Stat,
} from "@/components/app/frame";
import { Meter, Ring } from "@/components/app/viz";
import type { Role } from "@/lib/types";

export const metadata = { title: "Course · batch0" };
export const dynamic = "force-dynamic";

/**
 * The course, as a phone shows it: where am I, what have I finished, what's
 * next.
 *
 * Lessons link out to /dashboard/course/[id] rather than being reimplemented
 * here. That page is a video player with materials, comments and a progress
 * recorder — none of which gets better by being rebuilt at 390px, and all of
 * which would then need maintaining twice. What this screen owns is the map:
 * every week, how much of it is done, and one tap into any lesson.
 *
 * That per-lesson link is the ONLY way out of the app shell here, and it is
 * deliberate. There used to also be a "full course" link to /dashboard/course,
 * which was both wrong (assignments, comments and materials are on
 * /dashboard/course/[id], not on the index) and unrecoverable — that route
 * renders in the dashboard layout, which mounts the desktop sidebar and the
 * 17-link mobile nav and has no link back to /app. A student who tapped it was
 * out of the installed app for good.
 *
 * The current week is expanded and the rest collapse to a single row with a
 * count. Nine weeks of fully-expanded lesson lists is exactly the "overwhelming"
 * failure this surface exists to avoid.
 */
export default async function StudentAppCourse() {
  const { profile } = await requireViewer();
  const access = await getStudentAccess(profile.role as Role);
  const admin = createAdminClient();

  if (!access.enrolled) {
    return (
      <>
        <AppHeader title="Course" eyebrow="Locked" />
        <AppBody>
          <Alert tone="info" title="The course unlocks at enrollment.">
            Once your seat is paid for, every week's lessons and deliverables
            show up here.
          </Alert>
        </AppBody>
      </>
    );
  }
  if (access.preCohort) {
    const startLabel = fmtDateOnly(access.cohortStartsOn);
    return (
      <>
        <AppHeader
          title="Course"
          eyebrow={startLabel ? `Opens ${startLabel}` : "Opens soon"}
        />
        <AppBody>
          <Alert tone="info" title="Not open yet.">
            Week one goes live when the cohort starts
            {startLabel ? ` on ${startLabel}` : ""}. Kickoff and the pre-cohort
            resources are open in the meantime.
          </Alert>
        </AppBody>
      </>
    );
  }

  // ---- Wave 1: both keyed on the user alone ----
  // Progress used to wait behind the module list so it could be filtered to
  // those lessons. Fetching the student's whole completed set unfiltered is one
  // small table read and removes a serial round trip; the intersection is done
  // in memory below.
  const [{ data: enrollment }, { data: progress }] = await Promise.all([
    admin
      .from("enrollments")
      .select("cohort_id, cohort:cohorts(name, starts_on)")
      .eq("user_id", profile.id)
      // See the note on the same query in home/page.tsx: one row per cohort,
      // so a returning student needs the newest rather than "the" enrollment.
      .order("enrolled_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("lesson_progress")
      .select("lesson_id")
      .eq("user_id", profile.id)
      .not("completed_at", "is", null),
  ]);

  const cohortId = (enrollment?.cohort_id as string | null) ?? access.cohortId;
  const cohort = normalizeEmbed<{ name: string | null; starts_on: string | null }>(
    enrollment?.cohort,
  );

  if (!cohortId) {
    return (
      <>
        <AppHeader title="Course" />
        <AppBody>
          <Empty>No cohort assigned yet.</Empty>
        </AppBody>
      </>
    );
  }

  // ---- Wave 2: the whole syllabus, cached ----
  // Lessons ride along as a nested embed rather than a second query keyed on
  // the module ids, and the whole thing is cached per cohort for a minute
  // (lib/app-cache.ts) because a syllabus is authored once and read constantly.
  // Per-student progress is deliberately NOT part of that cache — it is fetched
  // above, uncached, so finishing a lesson shows up immediately.
  const modules = await getSyllabus(cohortId);

  const doneIds = new Set((progress ?? []).map((p) => p.lesson_id as string));
  const byModule = new Map<string, SyllabusModule["lessons"]>();
  let totalLessons = 0;
  let doneLessons = 0;
  for (const m of modules) {
    const items = m.lessons ?? [];
    byModule.set(m.id, items);
    totalLessons += items.length;
    doneLessons += items.filter((l) => doneIds.has(l.id)).length;
  }

  const week = cohortWeek(cohort?.starts_on);

  return (
    <>
      <AppHeader title="Course" eyebrow={cohort?.name ?? "batch0"} />
      <AppBody>
        {/* The headline number of the whole screen, and it used to live in the
            eyebrow — 10px mono at 0.2em in text-ink-faint, the weakest type on
            the page, and weaker than the desktop route this replaces, which
            draws it as a percentage and a bar. The eyebrow goes back to being
            what it is everywhere else in the app (which cohort am I in) and the
            aggregate gets the ring. Suppressed at zero lessons: 0% against an
            empty syllabus is a statement about the staff, not the student. */}
        {totalLessons > 0 && (
          <div className="mb-6">
            <Stat
              label="Course complete"
              value={`${doneLessons}/${totalLessons}`}
              graphic={
                <Ring
                  label="Course completion"
                  value={doneLessons}
                  max={totalLessons}
                  caption={`${doneLessons} of ${totalLessons} lessons done`}
                />
              }
            />
          </div>
        )}
        {modules.length === 0 ? (
          <Empty>No modules published yet. They appear as each week opens.</Empty>
        ) : (
          <div className="space-y-2.5">
            {modules.map((m) => {
              const items = byModule.get(m.id) ?? [];
              const done = items.filter((l) => doneIds.has(l.id)).length;
              const current = week !== null && m.week === week;
              // A module for a week that hasn't arrived is shown, but marked —
              // students plan around what's coming, and hiding it entirely makes
              // the course look shorter than it is.
              const ahead = week !== null && m.week > week;
              return (
                <details
                  key={m.id}
                  open={current}
                  className="group overflow-hidden rounded-2xl border border-line bg-wash open:bg-paper"
                >
                  {/* items-start, not items-center: the title clamps to two
                      lines and the meter sits under it, so a centred row would
                      float the eyebrow away from the card's top padding and
                      make cards of different heights start in different
                      places. The icons opt back into centring below. */}
                  <summary className="press flex min-h-[4.25rem] cursor-pointer list-none items-start gap-3.5 px-5 py-4 active:bg-wash [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <p
                        className={`font-mono text-[10px] font-medium uppercase tracking-[0.2em] ${
                          current ? "text-phosphor-ink" : "text-ink-faint"
                        }`}
                      >
                        Week {m.week}
                        {current && " · this week"}
                      </p>
                      {/* Two lines, not truncate. At 320px this column is ~200px
                          and a 15.5px face is ~9.3px/char, so one line cut a
                          module title at about 22 characters — the primary
                          content of the screen, unreadable on the narrowest
                          phone. The min-h above already reserved the room. */}
                      <p className="mt-1.5 line-clamp-2 text-[15.5px] leading-snug text-ink">
                        {m.title}
                      </p>
                      {items.length > 0 && (
                        // Was a right-aligned `3/5` mono column — a header
                        // column on the right edge, the most table-shaped thing
                        // in the app, and it charged the title ~21px of width
                        // to say what a bar says better. The Meter prints the
                        // same ratio beside a track, full width, under the
                        // title it describes.
                        <div className="mt-2.5">
                          <Meter
                            label={`Week ${m.week} lessons done`}
                            value={done}
                            max={items.length}
                            tone={done === items.length ? "good" : "default"}
                          />
                        </div>
                      )}
                    </div>
                    {/* self-center against a text column that is now two or
                        three lines tall — without it these ride up beside the
                        10px eyebrow. */}
                    <div className="flex shrink-0 items-center gap-2 self-center text-ink-faint">
                      {ahead && items.length === 0 && (
                        <Lock className="h-3.5 w-3.5" />
                      )}
                      {/* The only affordance saying these cards open. `list-none`
                          plus the webkit-marker rule removes the native
                          triangle on both engines, `cursor-pointer` means
                          nothing on touch and `active:bg-wash` arrives after
                          the tap — so a nine-week cohort showed eight identical
                          cards with no reason to try them. `group` is already
                          on the <details>, so the rotation costs no JS. */}
                      <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
                    </div>
                  </summary>

                  <div className="border-t border-line px-5">
                    {/* getSyllabus already fetches `summary` and this screen
                        never read it. It is what the week is about, and it is
                        half of what the deleted "full course" link was
                        offering. Free. */}
                    {m.summary && (
                      <p className="pt-4 text-[13.5px] leading-relaxed text-ink-soft">
                        {m.summary}
                      </p>
                    )}
                    {items.length === 0 ? (
                      <p className="py-5 text-[13.5px] text-ink-faint">
                        Lessons for this week aren&apos;t published yet.
                      </p>
                    ) : (
                      items.map((l) => {
                        const complete = doneIds.has(l.id);
                        return (
                          <Row
                            key={l.id}
                            label={l.title}
                            href={`/dashboard/course/${l.id}`}
                            muted={complete}
                            // The lesson player is a dynamic route with no
                            // loading boundary, and a week can list a dozen
                            // lessons — prefetching every visible one is a
                            // dozen server renders thrown away by
                            // staleTimes.dynamic = 0.
                            prefetch={false}
                            leading={
                              complete ? (
                                <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-600 dark:text-emerald-400" />
                              ) : (
                                <Circle className="h-[18px] w-[18px] shrink-0 text-ink-faint" />
                              )
                            }
                            // The duration used to sit in `right`, next to the
                            // play icon. Lesson titles are the tightest text in
                            // the app — at 320px this row is inside AppBody's
                            // px-5 AND the details body's px-5, so the label had
                            // ~145px, about fifteen characters. Moving the
                            // duration to `meta` (a run of text inside meta's
                            // <p>, which is valid) hands ~31px back to the
                            // title and leaves the right slot as the one icon.
                            meta={
                              l.duration_seconds
                                ? `${Math.round(l.duration_seconds / 60)}m`
                                : undefined
                            }
                            right={
                              <PlayCircle className="h-[18px] w-[18px] shrink-0 text-ink-faint" />
                            }
                          />
                        );
                      })
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </AppBody>
    </>
  );
}

function normalizeEmbed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
}
