/** Pure, fail-closed rules shared by recovery lists and payment reminders. */
export type RecoveryApplication = {
  id: string;
  user_id: string;
  cohort_id: string | null;
  status: string;
  followup_paused?: boolean;
  parent_email?: string | null;
  created_at?: string;
};
export type RecoveryPayment = { user_id: string; cohort_id: string | null; status: string; amount_refunded_cents?: number | null };
export type RecoveryEnrollment = { user_id: string; cohort_id: string };

export function recoveryBlocker(
  app: RecoveryApplication | null | undefined,
  payments: RecoveryPayment[],
  enrollments: RecoveryEnrollment[],
): string | null {
  if (!app?.cohort_id) return "No matching application and cohort";
  if (app.status !== "accepted") return "Application is no longer awaiting enrollment";
  if (app.followup_paused) return "Follow-up paused by the team";
  if (enrollments.some(e => e.user_id === app.user_id && e.cohort_id === app.cohort_id)) return "Already enrolled";
  const relevant = payments.filter(p => p.user_id === app.user_id && p.cohort_id === app.cohort_id);
  if (relevant.some(p => p.status === "succeeded")) return "Already paid";
  if (relevant.some(p => p.status === "refunded" || (p.amount_refunded_cents ?? 0) > 0)) return "Refund history: review before any follow-up";
  return null;
}

export function recoveryContext(vars: Record<string, unknown> | null | undefined) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const value = (key: string) => typeof vars?.[key] === "string" && uuid.test(vars[key] as string) ? vars[key] as string : null;
  return { applicationId: value("application_id"), cohortId: value("cohort_id") };
}
