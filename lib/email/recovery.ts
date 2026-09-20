import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recoveryBlocker } from "@/lib/email-recovery";
import { cohortEligibility } from "@/lib/cohort-eligibility";

export async function paymentReminderVerdict(ctx: { userId: string | null; applicationId?: string | null; cohortId?: string | null }) {
  if (!ctx.userId) return { send: false as const, reason: "Missing student context; parent reminders require the student's application" };
  try {
    const admin = createAdminClient();
    let query = admin.from("applications").select("id,user_id,cohort_id,status,followup_paused,cohort:cohorts(capacity,status,starts_on,ends_on,applications_close_at,late_entry_until,catch_up_plan)").eq("user_id", ctx.userId);
    if (ctx.applicationId) query = query.eq("id", ctx.applicationId);
    if (ctx.cohortId) query = query.eq("cohort_id", ctx.cohortId);
    const { data: apps, error } = await query;
    if (error || !apps || apps.length !== 1) return { send: false as const, reason: "Could not identify one current application; review before sending" };
    const app = apps[0];
    const [paymentResult, enrollmentResult, capacityResult] = await Promise.all([
      admin.from("payments").select("user_id,cohort_id,status,amount_refunded_cents").eq("user_id",ctx.userId).eq("cohort_id",app.cohort_id),
      admin.from("enrollments").select("user_id,cohort_id").eq("user_id",ctx.userId).eq("cohort_id",app.cohort_id),
      admin.from("enrollments").select("id",{head:true,count:"exact"}).eq("cohort_id",app.cohort_id),
    ]);
    if (paymentResult.error || enrollmentResult.error || capacityResult.error) return { send: false as const, reason: "Payment/enrollment check unavailable; review before sending" };
    const blocker = recoveryBlocker(app, paymentResult.data ?? [], enrollmentResult.data ?? []);
    if (blocker) return { send: false as const, reason: blocker };
    const cohort = Array.isArray(app.cohort) ? app.cohort[0] : app.cohort;
    if (!cohort || !cohortEligibility(cohort,new Date(),capacityResult.count ?? 0).eligible) return { send: false as const, reason: "Enrollment is no longer open for this cohort" };
    return { send: true as const };
  } catch {
    return { send: false as const, reason: "Could not verify reminder eligibility" };
  }
}
