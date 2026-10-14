/**
 * Weekly check-ins were retired for the assignment tracker (0093), which
 * carried over only the ones posted inside the Fall cohort's week 5–9 windows.
 * The rest, and the feedback mentors left on them, stay in student_checkins /
 * checkin_feedback, read-only. This shapes them into a read-only history for
 * the student, their mentors and admins (components/assignments/
 * earlier-checkins.tsx; lib/checkin-history-server.ts reads them). Pure and
 * import-free, so `node --test` runs it (lib/checkin-history.test.ts).
 */

export type CheckinRow = {
  id: string;
  week_start: string;
  accomplished: string | null;
  next_up: string | null;
  blockers: string | null;
  created_at: string;
};

export type CheckinFeedbackRow = {
  id: string;
  checkin_id: string;
  author_id: string;
  body: string;
  created_at: string;
};

export type CheckinHistoryItem = {
  id: string;
  /** Monday of the week, as stored (a bare date). */
  weekStart: string;
  accomplished: string | null;
  nextUp: string | null;
  blockers: string | null;
  feedback: { id: string; author: string; body: string; at: string }[];
};

function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/**
 * Newest week first; each check-in with its feedback oldest first. A blank
 * check-in with no feedback says nothing, so it's left out.
 */
export function checkinHistory(
  checkins: CheckinRow[],
  feedback: CheckinFeedbackRow[],
  names: Map<string, string>,
): CheckinHistoryItem[] {
  const byCheckin = new Map<string, CheckinFeedbackRow[]>();
  for (const f of feedback) {
    if (!clean(f.body)) continue;
    const list = byCheckin.get(f.checkin_id);
    if (list) list.push(f);
    else byCheckin.set(f.checkin_id, [f]);
  }
  return [...checkins]
    .sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : 0))
    .map((c) => ({
      id: c.id,
      weekStart: c.week_start,
      accomplished: clean(c.accomplished),
      nextUp: clean(c.next_up),
      blockers: clean(c.blockers),
      feedback: (byCheckin.get(c.id) ?? [])
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map((f) => ({
          id: f.id,
          author: names.get(f.author_id) ?? "Mentor",
          body: f.body.trim(),
          at: f.created_at,
        })),
    }))
    .filter((c) => c.accomplished || c.nextUp || c.blockers || c.feedback.length > 0);
}

/** "Week of Oct 5, 2026" for a bare YYYY-MM-DD, without a time zone shift. */
export function weekOfLabel(weekStart: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  if (!m) return "Week";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m[2]) - 1];
  if (!month) return "Week";
  return `Week of ${month} ${Number(m[3])}, ${m[1]}`;
}
