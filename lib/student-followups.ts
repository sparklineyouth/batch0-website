/**
 * Student follow-ups (migration 0107) — the pure rules. Relative .ts imports
 * so `node --test` runs it without a bundler; the reads are in
 * lib/student-followups-server.ts and the writes in
 * app/admin/progress/actions.ts.
 *
 * A follow-up is a member of staff saying "I'm checking on this student, I'll
 * look again on <date>", with a factual note. It exists so two people don't
 * chase the same student. Three things it deliberately is not:
 *
 *   - automatic. Only a person starts one. Nothing here looks at inactivity
 *     and decides a student needs chasing, or labels them "at risk" — the
 *     at-risk scores were retired in 0093 for exactly that reason;
 *   - a message. Starting, reassigning or closing one tells nobody anything:
 *     not the student, not the new owner;
 *   - a judgement. The note is for what happened ("Missed weeks 3 and 4;
 *     emailed Tuesday"), not for guesses about motivation or wellbeing. The
 *     drawer says so where the note is written.
 */
import type { Capabilities, Permission } from "./permissions.ts";
import { can } from "./permissions.ts";
import { addDays, isDate } from "./assignments.ts";
import { codePointLength, isUuid } from "./support-access.ts";

/** Reading follow-ups: the Student progress page's own key. */
export const FOLLOWUP_READ_PERMISSION: Permission = "people.view";
/** Starting, changing and closing one — and being its owner. */
export const FOLLOWUP_WRITE_PERMISSION: Permission = "people.manage";

export const FOLLOWUP_NOTE_MAX = 1000;
/** A next check further out than this is a reminder nobody will see. */
export const FOLLOWUP_MAX_DAYS_AHEAD = 120;
/** Where the date picker starts for a new follow-up. */
export const FOLLOWUP_DEFAULT_DAYS = 7;

export const FOLLOWUP_GUIDANCE =
  "Write what happened and what you'll check — facts, not guesses about how they feel. Nothing here is sent to anyone.";

export type FollowUpStatus = "open" | "closed";

/** The table's columns, as the server reads them. */
export const FOLLOWUP_COLUMNS =
  "id, student_id, owner_id, next_check_on, note, status, closing_note, created_by, updated_by, closed_by, closed_at, created_at, updated_at";

export type FollowUpRow = {
  id: string;
  student_id: string;
  owner_id: string | null;
  next_check_on: string;
  note: string;
  status: FollowUpStatus;
  closing_note: string | null;
  created_by: string | null;
  updated_by: string | null;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A follow-up with the names a page shows. */
export type FollowUpView = {
  id: string;
  studentId: string;
  studentName: string;
  ownerId: string | null;
  /** Null when there's no owner (their account was deleted). */
  ownerName: string | null;
  nextCheckOn: string;
  note: string;
  status: FollowUpStatus;
  closingNote: string | null;
  createdByName: string | null;
  createdAt: string;
  closedByName: string | null;
  closedAt: string | null;
  /** The edit token: a save names the version it started from. */
  updatedAt: string;
};

export function canReadFollowUps(caps: Capabilities | null): boolean {
  return can(caps, FOLLOWUP_READ_PERMISSION);
}

export function canWriteFollowUps(caps: Capabilities | null): boolean {
  return can(caps, FOLLOWUP_WRITE_PERMISSION) && can(caps, FOLLOWUP_READ_PERMISSION);
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type FollowUpDueState = "overdue" | "due" | "upcoming" | "closed";

/** Where an open follow-up stands against today (a New York date). */
export function followUpDueState(
  row: { status: FollowUpStatus; next_check_on?: string; nextCheckOn?: string },
  today: string,
): FollowUpDueState {
  if (row.status !== "open") return "closed";
  const on = row.nextCheckOn ?? row.next_check_on ?? "";
  const d = daysBetween(today, on);
  if (!Number.isFinite(d)) return "upcoming";
  return d < 0 ? "overdue" : d === 0 ? "due" : "upcoming";
}

/** Due today or earlier: what the attention list shows. */
export function isFollowUpDue(row: { status: FollowUpStatus; next_check_on?: string; nextCheckOn?: string }, today: string): boolean {
  const s = followUpDueState(row, today);
  return s === "due" || s === "overdue";
}

/** "Due today", "Due 3 days ago", "In 4 days" — relative to today in New York. */
export function followUpDueLabel(nextCheckOn: string, today: string): string {
  const d = daysBetween(today, nextCheckOn);
  if (!Number.isFinite(d)) return "";
  if (d === 0) return "Due today";
  if (d === -1) return "Due yesterday";
  if (d < 0) return `Due ${-d} days ago`;
  if (d === 1) return "Tomorrow";
  return `In ${d} days`;
}

const checkDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/**
 * "Tue, Oct 20" for a stored date. Formatted at noon UTC of that calendar
 * day, so the server and every browser print the same day whatever their
 * time zone — a date has no time to shift.
 */
export function formatCheckDate(date: string): string {
  if (!isDate(date)) return "";
  return checkDateFormat.format(new Date(`${date}T12:00:00Z`));
}

/** Where the date picker starts: the open follow-up's date while it's still ahead, else a week out. */
export function defaultNextCheck(active: { nextCheckOn: string } | null, today: string): string {
  if (active && isDate(active.nextCheckOn) && active.nextCheckOn > today) return active.nextCheckOn;
  return addDays(today, FOLLOWUP_DEFAULT_DAYS);
}

export type FollowUpInput = { ownerId: string; nextCheckOn: string; note: string };

/**
 * Check what the drawer sent. The next check is today or later (a past date
 * on save would put it straight back in the attention list) and at most
 * FOLLOWUP_MAX_DAYS_AHEAD out; the note is required, because the person who
 * opens the follow-up after you needs to know what it's about.
 */
export function parseFollowUpInput(
  raw: { ownerId?: unknown; nextCheckOn?: unknown; note?: unknown },
  today: string,
): { ok: true; value: FollowUpInput } | { ok: false; error: string } {
  const ownerId = typeof raw.ownerId === "string" ? raw.ownerId.trim().toLowerCase() : "";
  if (!isUuid(ownerId)) return { ok: false, error: "Pick who owns this follow-up." };
  const nextCheckOn = typeof raw.nextCheckOn === "string" ? raw.nextCheckOn.trim() : "";
  if (!isDate(nextCheckOn)) return { ok: false, error: "Pick the date you'll check again." };
  if (nextCheckOn < today) return { ok: false, error: "The next check can't be in the past." };
  if (nextCheckOn > addDays(today, FOLLOWUP_MAX_DAYS_AHEAD)) {
    return { ok: false, error: `Pick a date within ${FOLLOWUP_MAX_DAYS_AHEAD} days.` };
  }
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (!note) return { ok: false, error: "Add a short note: what happened, and what you'll check." };
  if (codePointLength(note) > FOLLOWUP_NOTE_MAX) {
    return { ok: false, error: `Keep the note under ${FOLLOWUP_NOTE_MAX} characters.` };
  }
  return { ok: true, value: { ownerId, nextCheckOn, note } };
}

/** The optional note left when closing. Empty is fine; too long isn't. */
export function parseClosingNote(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const note = typeof raw === "string" ? raw.trim() : "";
  if (!note) return { ok: true, value: null };
  if (codePointLength(note) > FOLLOWUP_NOTE_MAX) {
    return { ok: false, error: `Keep the note under ${FOLLOWUP_NOTE_MAX} characters.` };
  }
  return { ok: true, value: note };
}

/**
 * Who may own a follow-up: anyone whose role can also change it, so an owner
 * is never stuck with a follow-up they can't update or close. Takes role rows
 * (slug + permissions) so it runs on lib/roles.ts output as-is.
 */
export function followUpOwnerRoleSlugs(roles: readonly { slug: string; permissions: readonly string[] }[]): string[] {
  const holds = (perms: readonly string[], p: string) => perms.includes("*") || perms.includes(p);
  return roles
    .filter((r) => holds(r.permissions, FOLLOWUP_WRITE_PERMISSION) && holds(r.permissions, FOLLOWUP_READ_PERMISSION))
    .map((r) => r.slug);
}

/**
 * The unique index on open follow-ups (0107) refusing a second one. The only
 * other unique key on the table is a generated uuid, so a 23505 on insert is
 * always this one — whatever the message says.
 */
export function isOneOpenConflict(error: { code?: string } | null | undefined): boolean {
  return !!error && error.code === "23505";
}
