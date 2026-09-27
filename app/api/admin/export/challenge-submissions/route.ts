import { createAdminClient } from "@/lib/supabase/admin";
import { viewerCan } from "@/lib/auth";
import { toCsv, csvResponse } from "@/lib/csv";
import {
  getChallengeById,
  isInputQuestion,
  isUploadAnswer,
  sanitizeQuestions,
  type ChallengeAnswerValue,
  type ChallengeQuestion,
  type TeamMember,
  type UploadedFile,
} from "@/lib/challenges";

export const dynamic = "force-dynamic";

function cell(q: ChallengeQuestion, v: ChallengeAnswerValue | undefined): string {
  if (v == null) return "";
  if (isUploadAnswer(v)) return "(uploaded video — view in admin)";
  if (q.type === "file" && Array.isArray(v)) {
    return (v as UploadedFile[]).map((f) => f?.name ?? "").join("; ");
  }
  if (q.type === "team" && Array.isArray(v)) {
    return (v as TeamMember[]).map((m) => (m?.email ? `${m.name} <${m.email}>` : (m?.name ?? ""))).join("; ");
  }
  if (Array.isArray(v)) {
    // Defensive: a question whose type changed after entries arrived can
    // leave objects here; never print "[object Object]".
    return (v as unknown[])
      .map((x) =>
        x && typeof x === "object"
          ? String((x as any).name ?? "") + ((x as any).email ? ` <${(x as any).email}>` : "")
          : String(x),
      )
      .join("; ");
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** Every submitted entry for one challenge, one column per current question. */
export async function GET(req: Request) {
  if (!(await viewerCan("challenges.manage"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const challenge = await getChallengeById(id);
  if (!challenge) return new Response("Not found", { status: 404 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("challenge_submissions")
    .select(
      "id, status, submitted_at, award_label, payout_amount_cents, referral_code, answers, questions_snapshot, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email)",
    )
    .eq("challenge_id", id)
    .neq("status", "draft")
    .order("submitted_at", { ascending: true });
  if (error) return new Response("Export unavailable", { status: 503 });

  // Columns: the current questions in order, then any question an entry was
  // submitted against that's since been removed (edits never erase answers —
  // each entry keeps its own snapshot — so the export mustn't either).
  const cols = new Map<string, { q: ChallengeQuestion; removed: boolean }>();
  for (const q of challenge.questions.filter(isInputQuestion)) cols.set(q.id, { q, removed: false });
  const snapshots = (data ?? []).map((s: any) => sanitizeQuestions(s.questions_snapshot));
  for (const snap of snapshots) {
    for (const q of snap.filter(isInputQuestion)) {
      if (!cols.has(q.id)) cols.set(q.id, { q, removed: true });
    }
  }
  const columns = Array.from(cols.values());

  const rows = (data ?? []).map((s: any, i: number) => {
    const p = Array.isArray(s.applicant) ? s.applicant[0] : s.applicant;
    const own = new Map(snapshots[i].map((q) => [q.id, q]));
    return [
      s.id,
      s.status === "funded" ? "winner" : s.status,
      s.submitted_at ?? "",
      p?.full_name ?? "",
      p?.email ?? "",
      s.award_label ?? "",
      s.payout_amount_cents != null ? (s.payout_amount_cents / 100).toFixed(2) : "",
      // Format by the definition the entry was submitted against.
      ...columns.map(({ q }) => cell(own.get(q.id) ?? q, s.answers?.[q.id])),
    ];
  });

  const csv = toCsv(
    [
      "id", "status", "submitted_at", "name", "email", "award", "payout",
      ...columns.map(({ q, removed }) => (removed ? `${q.label} (removed)` : q.label)),
    ],
    rows,
  );
  return csvResponse(`${challenge.slug}-submissions.csv`, csv);
}
