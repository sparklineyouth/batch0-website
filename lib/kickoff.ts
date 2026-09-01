// ---------------------------------------------------------------------------
// Kickoff content — shared, pure logic.
//
// The kickoff page used to be a hardcoded block of copy: an admin could not
// say when the call was, where it happened, or what was on the agenda, and a
// cohort with no start date rendered a page whose headline was literally
// "Date coming soon".
//
// Migration 0049 put that content in `cohort_kickoff` (one nullable-everything
// row per cohort). This module is the single place that turns such a row —
// edited, empty, or entirely absent — into a fully-populated view model. Every
// field resolves to something real, so the page can never render blank.
//
// Imported by the student page, the admin editor, and the admin server action,
// so keep it dependency-free and side-effect-free: no React, no icons, no
// Supabase client, no next/headers.
// ---------------------------------------------------------------------------

import { fmtDateOnly } from "@/lib/pre-cohort";

export type KickoffAgendaItem = { title: string; body: string };
export type KickoffChecklistItem = { label: string; href: string };

/** A `cohort_kickoff` row, exactly as it comes back from Supabase. */
export type KickoffRow = {
  headline: string | null;
  intro: string | null;
  time_label: string | null;
  location_label: string | null;
  join_url: string | null;
  agenda: unknown;
  checklist: unknown;
  note: string | null;
};

/** The columns to select from `cohort_kickoff`. */
export const KICKOFF_COLUMNS =
  "headline, intro, time_label, location_label, join_url, agenda, checklist, note";

/**
 * Read one cohort's kickoff row, tolerating the table not existing yet.
 *
 * Migrations in this project are applied by hand in the Supabase SQL editor,
 * so there is always a window where the deployed code is ahead of the schema.
 * Every field here is optional by design, and "no row" and "no table" mean the
 * same thing to the page — the defaults — so the only wrong behaviour would be
 * letting a missing table take the whole page down with it.
 *
 * Kept as its own query rather than an embed on the cohorts select for exactly
 * that reason: an embed against a missing relation fails the parent query too,
 * which would cost the page the cohort's name and start date as well.
 */
export async function readKickoffRow(
  client: { from: (t: string) => any },
  cohortId: string,
): Promise<KickoffRow | null> {
  try {
    const { data, error } = await client
      .from("cohort_kickoff")
      .select(KICKOFF_COLUMNS)
      .eq("cohort_id", cohortId)
      .maybeSingle();
    if (error) {
      console.error("[kickoff] cohort_kickoff unavailable:", error.message);
      return null;
    }
    return (data as KickoffRow) ?? null;
  } catch (e) {
    console.error("[kickoff] cohort_kickoff read failed:", (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Where the cohort sits relative to its own kickoff.
 *
 * The old page had no notion of this: it keyed off `preCohort`, which flips
 * false the moment `starts_on <= today`. That made the day of kickoff itself
 * indistinguishable from six weeks later — and it meant the page's own
 * "Kickoff is today" branch was unreachable code, because on the day the page
 * had already redirected the student away.
 */
export type KickoffPhase =
  | "undated" // no start date on the books yet
  | "upcoming" // still ahead
  | "today" // it is happening today
  | "past" // it has happened
  | "cancelled"; // the cohort was called off

export function kickoffPhase(
  startsOn: string | null,
  status: string | null,
  started: boolean,
  today: string,
): KickoffPhase {
  if (status === "cancelled") return "cancelled";
  if (startsOn && startsOn === today) return "today";
  if (!startsOn) return started ? "past" : "undated";
  return started ? "past" : "upcoming";
}

// ---------------------------------------------------------------------------
// Defaults
//
// These are what a cohort nobody has edited shows — the copy the page shipped
// with, kept verbatim so an uncustomised cohort reads exactly as it did before.
// They are deliberately true of every batch0 cohort, so leaving a new cohort's
// kickoff row empty is a perfectly reasonable thing for an admin to do.
// ---------------------------------------------------------------------------

export const DEFAULT_AGENDA: readonly KickoffAgendaItem[] = [
  {
    title: "The course",
    body: "Weekly modules and deliverables open, starting with week one. You'll ship something every week from day one.",
  },
  {
    title: "Your cohort",
    body: "Announcements, events, and the shared cohort surfaces go live. Discord and your team page are already open — start there.",
  },
  {
    title: "Events & office hours",
    body: "The full schedule appears: mentor office hours, workshops, and the road to Demo Day.",
  },
  {
    title: "Weekly check-ins",
    body: "Every week you report progress, blockers, and momentum. The first one lands in week one.",
  },
];

export const DEFAULT_CHECKLIST: readonly KickoffChecklistItem[] = [
  {
    label: "Work through Before One — your pre-cohort flows",
    href: "/dashboard/resources",
  },
  { label: "Link Discord and meet your cohort", href: "/dashboard/community" },
  { label: "Start your team — or accept an invite", href: "/dashboard/team" },
  { label: "Complete your profile", href: "/dashboard/settings" },
];

export const DEFAULT_NOTE =
  "The founders who get the most out of batch0 arrive with the pre-cohort readings done and a one-page sketch of their idea. Show up ready to build.";

const DEFAULT_HEADLINE_UNDATED = "Kickoff is being scheduled";
const DEFAULT_HEADLINE_CANCELLED = "This cohort was cancelled";

const INTRO: Record<KickoffPhase, string> = {
  upcoming:
    "Kickoff is day one of the cohort — the moment the full program unlocks. Until then this page, Discord, your team, and the pre-cohort resources are your launchpad.",
  today:
    "Today is day one. The full program unlocks with kickoff — the course, the schedule, and every cohort surface. Everything you need is on this page.",
  past: "Kickoff has happened and the full program is open. This page stays here as the record of day one: the call details, and what went live with it.",
  undated:
    "Your cohort's kickoff date hasn't been posted yet. You'll get an email and a Discord ping the moment it is — in the meantime, the list on the right is the work that pays off before day one.",
  cancelled:
    "This cohort was cancelled, so there's no kickoff to count down to. If you haven't already heard from us about what happens next, reach out and we'll sort it.",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function trimmed(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

/**
 * jsonb comes back as `unknown`. Anything that isn't a well-formed array of
 * well-formed rows resolves to null so the caller falls back to the default —
 * bad data shows the default page, never an empty one.
 */
export function parseAgenda(value: unknown): KickoffAgendaItem[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const title = trimmed((r as any).title);
      if (!title) return null;
      return { title, body: trimmed((r as any).body) ?? "" };
    })
    .filter((r): r is KickoffAgendaItem => r !== null);
  return rows.length > 0 ? rows : null;
}

export function parseChecklist(value: unknown): KickoffChecklistItem[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const label = trimmed((r as any).label);
      const href = trimmed((r as any).href);
      if (!label || !href || !isSafeHref(href)) return null;
      return { label, href };
    })
    .filter((r): r is KickoffChecklistItem => r !== null);
  return rows.length > 0 ? rows : null;
}

/**
 * Links an admin may point the checklist at: somewhere inside the app, or an
 * https URL. Rejects `javascript:`, `data:`, and protocol-relative `//host` —
 * the value is rendered straight into an href, and holding an admin account is
 * not a reason to let a script URL through.
 */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (h.startsWith("//")) return false;
  if (h.startsWith("/")) return true;
  return /^https:\/\/[^\s]+$/i.test(h);
}

export function isExternalHref(href: string): boolean {
  return /^https:\/\//i.test(href.trim());
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type KickoffCohort = {
  name: string | null;
  startsOn: string | null;
  status: string | null;
  /** The cohort has already begun — from cohortHasStarted(). */
  started: boolean;
};

export type ResolvedKickoff = {
  /** "Fall 2026" — the eyebrow above the heading. */
  cohortLabel: string;
  phase: KickoffPhase;
  headline: string;
  intro: string;
  /** Formatted start date, or null when the cohort has no date yet. */
  dateLabel: string | null;
  timeLabel: string | null;
  locationLabel: string | null;
  joinUrl: string | null;
  agenda: KickoffAgendaItem[];
  checklist: KickoffChecklistItem[];
  note: string;
  /** Whole days until kickoff. Only set while it's still ahead. */
  daysLeft: number | null;
  /** True when the admin has customised nothing — drives the staff hint. */
  usingDefaults: boolean;
};

/**
 * Merge an admin-edited kickoff row over the defaults.
 *
 * `row` is null both when nobody has edited this cohort and when the student
 * has no cohort at all (paid, not yet placed) — both are real states, and both
 * must still produce a complete page.
 */
export function resolveKickoff(
  row: KickoffRow | null,
  cohort: KickoffCohort,
  today: string,
): ResolvedKickoff {
  const phase = kickoffPhase(
    cohort.startsOn,
    cohort.status,
    cohort.started,
    today,
  );
  const dateLabel = fmtDateOnly(cohort.startsOn);
  const agenda = parseAgenda(row?.agenda);
  const checklist = parseChecklist(row?.checklist);
  const headline = trimmed(row?.headline);
  const intro = trimmed(row?.intro);
  const timeLabel = trimmed(row?.time_label);
  const locationLabel = trimmed(row?.location_label);
  const joinUrl = trimmed(row?.join_url);
  const note = trimmed(row?.note);

  return {
    cohortLabel: cohort.name ?? "Your cohort",
    phase,
    headline: headline ?? defaultHeadline(phase, dateLabel),
    intro: intro ?? INTRO[phase],
    dateLabel,
    timeLabel,
    locationLabel,
    // A cancelled cohort's call link is noise at best and a wrong room at
    // worst — never surface it.
    joinUrl:
      phase !== "cancelled" && joinUrl && isSafeHref(joinUrl) ? joinUrl : null,
    agenda: agenda ?? [...DEFAULT_AGENDA],
    checklist: checklist ?? [...DEFAULT_CHECKLIST],
    note: note ?? DEFAULT_NOTE,
    daysLeft: phase === "upcoming" ? daysUntil(cohort.startsOn, today) : null,
    usingDefaults:
      !headline &&
      !intro &&
      !agenda &&
      !checklist &&
      !note &&
      !joinUrl &&
      !timeLabel &&
      !locationLabel,
  };
}

function defaultHeadline(phase: KickoffPhase, dateLabel: string | null): string {
  if (phase === "cancelled") return DEFAULT_HEADLINE_CANCELLED;
  if (!dateLabel) return DEFAULT_HEADLINE_UNDATED;
  if (phase === "past") return `Kickoff was ${dateLabel}`;
  return dateLabel;
}

/**
 * Whole calendar days from `today` to `startsOn`. Both are plain UTC dates
 * (cohorts.starts_on is a `date`), so this is exact — no clock drift, no
 * timezone rounding.
 */
export function daysUntil(
  startsOn: string | null,
  today: string,
): number | null {
  if (!startsOn) return null;
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(now)) return null;
  return Math.max(0, Math.round((start - now) / 86_400_000));
}

/** "3 days to go" / "1 day to go" / "Kickoff is tomorrow". */
export function daysLeftLabel(days: number): string {
  if (days <= 0) return "Kickoff is today";
  if (days === 1) return "Kickoff is tomorrow";
  return `${days} days to go`;
}
