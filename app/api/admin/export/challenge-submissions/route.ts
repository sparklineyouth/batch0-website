import { createAdminClient } from "@/lib/supabase/admin";
import { viewerCan } from "@/lib/auth";
import { toCsv, csvResponse } from "@/lib/csv";
import {
  getChallengeById,
  isInputQuestion,
  isUploadAnswer,
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
    return (v as UploadedFile[]).map((f) => f.name).join("; ");
  }
  if (q.type === "team" && Array.isArray(v)) {
    return (v as TeamMember[]).map((m) => (m.email ? `${m.name} <${m.email}>` : m.name)).join("; ");
  }
  if (Array.isArray(v)) return (v as string[]).join("; ");
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
      "id, status, submitted_at, award_label, payout_amount_cents, referral_code, answers, applicant:profiles!challenge_submissions_user_id_fkey(full_name, email)",
    )
    .eq("challenge_id", id)
    .neq("status", "draft")
    .order("submitted_at", { ascending: true });
  if (error) return new Response("Export unavailable", { status: 503 });

  const questions = challenge.questions.filter(isInputQuestion);
  const rows = (data ?? []).map((s: any) => {
    const p = Array.isArray(s.applicant) ? s.applicant[0] : s.applicant;
    return [
      s.id,
      s.status === "funded" ? "winner" : s.status,
      s.submitted_at ?? "",
      p?.full_name ?? "",
      p?.email ?? "",
      s.award_label ?? "",
      s.payout_amount_cents != null ? (s.payout_amount_cents / 100).toFixed(2) : "",
      ...questions.map((q) => cell(q, s.answers?.[q.id])),
    ];
  });

  const csv = toCsv(
    ["id", "status", "submitted_at", "name", "email", "award", "payout", ...questions.map((q) => q.label)],
    rows,
  );
  return csvResponse(`${challenge.slug}-submissions.csv`, csv);
}
