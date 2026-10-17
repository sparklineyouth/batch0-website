import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { courseWeekStart, courseWeekWindow, easternToUtc } from "@/lib/assignments";
import {
  cohortFileRefs,
  cohortReadiness,
  type ReadinessEvent,
  type ReadinessInput,
  type ReadinessModule,
} from "@/lib/cohort-readiness";
import { CohortsManager } from "@/app/admin/cohorts/cohorts-manager";

/**
 * Interface preview for the cohort readiness checklist on /admin/cohorts.
 *
 * The real page needs a signed-in admin and the database; this runs the same
 * rules (lib/cohort-readiness.ts) over fixtures — a ready cohort and one with
 * missing files, a stale assignment and an empty calendar — and renders the
 * real cohorts table with them. Links point at the real editors, and Save and
 * Delete call the real server actions; all of them refuse without a session.
 *
 * Gated on VERCEL_ENV like the other /dev previews: localhost and branch
 * previews only.
 */
export const metadata = {
  title: "Cohort readiness preview · batch0",
  robots: { index: false, follow: false },
};

const START = "2026-12-14";
const END = "2027-02-12";
const NOW = new Date("2026-10-17T16:00:00Z");
const FALL = "00000000-0000-4000-8000-0000000000a1";
const WINTER = "00000000-0000-4000-8000-0000000000a2";
const WINTER_B = "00000000-0000-4000-8000-0000000000a3";

/** A cohorts-table row. Completed cohorts get no checklist. */
function row(id: string, name: string, n: number, status: "upcoming" | "completed" = "upcoming") {
  return {
    id,
    name,
    cohort_number: n,
    starts_on: status === "completed" ? "2026-09-14" : START,
    ends_on: status === "completed" ? "2026-11-13" : END,
    capacity: 24,
    status,
    price_cents: 13000,
    applications_close_at: null,
    late_entry_until: null,
    catch_up_plan: null,
    enrollments: [{ count: 6 }],
  };
}

function modules(): ReadinessModule[] {
  return Array.from({ length: 9 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    week: i + 1,
    title: `Week ${i + 1}`,
    position: 0,
    lessons: [
      {
        id: `lesson-${i + 1}`,
        title: `Lesson ${i + 1}`,
        position: 0,
        description: "Read this.",
        video_path: null,
        video_url: null,
        materials: [{ title: `Workbook ${i + 1}.pdf`, path: `preview/workbook-${i + 1}.pdf` }],
      },
    ],
  }));
}

function sessions(): ReadinessEvent[] {
  return Array.from({ length: 9 }, (_, i) => {
    const startsAt = easternToUtc(courseWeekStart(START, i + 1)!, "20:00")!;
    return {
      id: `event-${i + 1}`,
      title: "Workshop",
      visibility: "enrolled",
      live_mode: "hosted",
      starts_at: startsAt,
      ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
      zoom_url: null,
      live_ended_at: null,
    };
  });
}

function base(id: string, name: string): ReadinessInput {
  const mods = modules();
  return {
    cohort: {
      id,
      name,
      status: "upcoming",
      starts_on: START,
      ends_on: END,
      capacity: 24,
      price_cents: 13000,
      applications_close_at: "2026-12-12T23:59:00Z",
      enrolled: 6,
    },
    modules: mods,
    resources: [],
    assignments: Array.from({ length: 9 }, (_, i) => {
      const w = courseWeekWindow({ startsOn: START, endsOn: END, week: i + 1 })!;
      return {
        id: `a${i}`,
        title: "Weekly update",
        status: "published",
        module_id: null,
        lesson_id: null,
        week: i + 1,
        opens_at: w.opensAt,
        due_at: w.dueAt,
      };
    }),
    events: sessions(),
    kickoff: {
      row: {
        headline: null,
        intro: null,
        time_label: "Mondays, 8–9 p.m. Eastern",
        location_label: "Live inside batch0",
        join_url: "/dashboard/events",
        agenda: null,
        checklist: null,
        note: null,
      },
    },
    files: {
      "course-materials": new Set(cohortFileRefs(mods, []).refs.map((r) => r.path)),
      "course-videos": new Set(),
      resources: new Set(),
    },
    now: NOW,
  };
}

export default function CohortReadinessPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  const ready = cohortReadiness(base(WINTER, "Winter 2026"));

  const broken = base(WINTER_B, "Winter 2026 B");
  broken.files = { ...broken.files, "course-materials": new Set(["preview/workbook-1.pdf", "preview/workbook-2.pdf"]) };
  broken.assignments = [
    ...broken.assignments!.slice(1),
    {
      id: "stale",
      title: "Problem statement",
      status: "published",
      module_id: null,
      lesson_id: null,
      week: null,
      opens_at: null,
      due_at: "2026-10-01T03:59:00Z",
    },
  ];
  broken.events = [];
  broken.kickoff = { row: null };
  const needsWork = cohortReadiness(broken);

  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <p className="mb-6 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
        Preview over fixtures, as of Oct 17, 2026. Links open the real editors, which need an admin session.
      </p>
      <Card>
        <CohortsManager
          initialCohorts={[row(WINTER, "Winter 2026", 2), row(WINTER_B, "Winter 2026 B", 3), row(FALL, "Fall 2026", 1, "completed")]}
          promoConfig={{ enabled: false, percent: 0, endsAt: null }}
          readiness={{ [WINTER]: ready, [WINTER_B]: needsWork }}
        />
      </Card>
    </main>
  );
}
