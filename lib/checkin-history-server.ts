import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  checkinHistory,
  type CheckinFeedbackRow,
  type CheckinHistoryItem,
  type CheckinRow,
} from "@/lib/checkin-history";

/**
 * One student's retired weekly check-ins with the feedback on them
 * (lib/checkin-history.ts). Service role, filtered to `studentId`: the caller
 * must already have decided the viewer may see this student (the student
 * themselves, a mentor in scope, or people.view). Any failed read is an empty
 * history.
 */
export async function loadCheckinHistory(studentId: string): Promise<CheckinHistoryItem[]> {
  const admin = createAdminClient();
  try {
    const { data: checkins } = await admin
      .from("student_checkins")
      .select("id, week_start, accomplished, next_up, blockers, created_at")
      .eq("user_id", studentId)
      .order("week_start", { ascending: false })
      .limit(52);
    const rows = (checkins ?? []) as CheckinRow[];
    if (rows.length === 0) return [];

    const { data: fb } = await admin
      .from("checkin_feedback")
      .select("id, checkin_id, author_id, body, created_at")
      .in("checkin_id", rows.map((r) => r.id));
    const feedback = (fb ?? []) as CheckinFeedbackRow[];

    const names = new Map<string, string>();
    const authorIds = Array.from(new Set(feedback.map((f) => f.author_id)));
    if (authorIds.length > 0) {
      const { data: people } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", authorIds);
      for (const p of (people ?? []) as { id: string; full_name: string | null }[]) {
        const name = p.full_name?.trim();
        if (name) names.set(p.id, name);
      }
    }
    return checkinHistory(rows, feedback, names);
  } catch (err) {
    console.error("[checkin-history] load failed", err);
    return [];
  }
}
