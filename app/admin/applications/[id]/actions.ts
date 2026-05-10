"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

export async function decideApplication(
  applicationId: string,
  decision: "accepted" | "rejected",
  notes: string,
) {
  const { userId: reviewerId } = await assertAdmin();
  const admin = createAdminClient();

  // Fetch first so we can email + notify with full context.
  const { data: app, error: fetchErr } = await admin
    .from("applications")
    .select(
      "id, full_name, user_id, cohort:cohorts(name, price_cents), profile:profiles(email, full_name)",
    )
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchErr || !app) throw new Error(fetchErr?.message ?? "Not found");

  const { error } = await admin
    .from("applications")
    .update({
      status: decision,
      review_notes: notes || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerId,
    })
    .eq("id", applicationId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: `application.${decision}`,
    targetType: "application",
    targetId: applicationId,
    payload: { notes: notes || null },
  });

  // Email + in-app notify the applicant.
  try {
    const a = app as any;
    const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
    const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    if (decision === "accepted") {
      const t = Templates.applicationAccepted({
        name: a.full_name ?? profile?.full_name ?? null,
        cohortName: cohort?.name ?? "SparkLine",
        priceCents: cohort?.price_cents ?? 9700,
      });
      if (profile?.email) {
        await sendEmail({
          to: profile.email,
          subject: t.subject,
          html: t.html,
        });
      }
      await notify({
        userId: a.user_id,
        type: "application_accepted",
        title: "You're in",
        body: `Welcome to ${cohort?.name ?? "SparkLine"}. Pay to lock in your seat.`,
        link: "/dashboard/application",
      });
    } else {
      const t = Templates.applicationRejected({
        name: a.full_name ?? profile?.full_name ?? null,
        notes: notes || null,
      });
      if (profile?.email) {
        await sendEmail({
          to: profile.email,
          subject: t.subject,
          html: t.html,
        });
      }
      await notify({
        userId: a.user_id,
        type: "application_rejected",
        title: "Application decision",
        body: "You weren't selected for this cohort.",
        link: "/dashboard/application",
      });
    }
  } catch (err) {
    console.error("[applications] decide notify failed", err);
  }

  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
  revalidatePath("/admin");
}

export async function reopenApplication(applicationId: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("applications")
    .update({
      status: "submitted",
      reviewed_at: null,
      reviewed_by: null,
      review_notes: null,
    })
    .eq("id", applicationId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "application.reopened",
    targetType: "application",
    targetId: applicationId,
  });
  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
}
