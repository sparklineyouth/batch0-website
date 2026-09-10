"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { sendEmail } from "@/lib/email/send";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { syncMemberRoles } from "@/lib/discord";
import {
  applyApplicationDecision,
  type StructuredFeedback,
} from "@/lib/application-decisions";

export type { StructuredFeedback } from "@/lib/application-decisions";

export async function decideApplication(
  applicationId: string,
  decision: "accepted" | "rejected" | "waitlisted",
  notes: string,
  // Structured rejection feedback (perk 3). Only meaningful when declining a
  // pass holder; ignored on accept and for non-holders. The single-app review
  // UI collects it for pass holders; bulk decisions pass it undefined and fall
  // back to the free-text notes guarantee inside applyApplicationDecision.
  feedback?: StructuredFeedback,
) {
  // The permission check is the ONLY thing this reviewer-facing wrapper adds
  // over the shared core in lib/application-decisions.ts. The scheduled-accept
  // cron calls that core directly with the reviewer who parked the acceptance,
  // so a hand-clicked accept and a scheduled one run identically.
  const { userId: reviewerId } = await assertPermission("applications.review");
  await applyApplicationDecision(applicationId, decision, notes, reviewerId, feedback);
}

/**
 * Park an acceptance for a future moment instead of accepting now. The
 * application stays `submitted`; the cron `/api/cron/scheduled-accepts` runs
 * the real acceptance once `scheduledAt` has passed. Re-scheduling an already
 * parked application just overwrites the time/notes.
 */
export async function scheduleAcceptance(
  applicationId: string,
  scheduledAt: string,
  notes: string,
) {
  const { userId: reviewerId } = await assertPermission("applications.review");
  const admin = createAdminClient();

  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) {
    throw new Error("Pick a valid date and time.");
  }
  // A schedule in the past would fire on the very next cron run, which is just
  // a slower "accept now" and almost certainly a mistake (a mis-typed year, a
  // timezone slip). Require a future moment; if they want it now, that's the
  // Accept button.
  if (when.getTime() <= Date.now()) {
    throw new Error("Pick a time in the future — to accept now, use Accept.");
  }

  const { data: app, error: fetchErr } = await admin
    .from("applications")
    .select("id, status")
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchErr || !app) throw new Error(fetchErr?.message ?? "Not found");
  // Only an undecided application can be scheduled. A paid/enrolled/accepted/
  // rejected row is already resolved — scheduling one would either no-op or
  // silently un-decide it when the cron fired.
  if (
    app.status !== "submitted" &&
    app.status !== "draft" &&
    app.status !== "waitlisted"
  ) {
    throw new Error(
      `This application is "${app.status}" and can't be scheduled — re-open it first.`,
    );
  }

  const { error } = await admin
    .from("applications")
    .update({
      scheduled_accept_at: when.toISOString(),
      scheduled_accept_notes: notes?.trim() || null,
      scheduled_accept_by: reviewerId,
    })
    .eq("id", applicationId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "application.accept_scheduled",
    targetType: "application",
    targetId: applicationId,
    payload: { scheduled_accept_at: when.toISOString() },
  });

  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
}

/** Cancel a parked acceptance, leaving the application undecided. */
export async function cancelScheduledAcceptance(applicationId: string) {
  await assertPermission("applications.review");
  const admin = createAdminClient();
  const { error } = await admin
    .from("applications")
    .update({
      scheduled_accept_at: null,
      scheduled_accept_notes: null,
      scheduled_accept_by: null,
    })
    .eq("id", applicationId);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "application.accept_schedule_canceled",
    targetType: "application",
    targetId: applicationId,
  });
  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
}

/**
 * Bulk equivalent of decideApplication. Runs sequentially — each call
 * already does an email send + in-app notify + (on accept) a Discord
 * sync, so a parallel fan-out would hammer those services and is more
 * likely to trip rate limits than save real time. Returns counts so the
 * UI can surface "X succeeded, Y failed" without inventing its own
 * accounting.
 *
 * Skips applications that aren't in a decidable state ("submitted",
 * "draft", or "waitlisted" — waitlisted rows can be bulk-accepted when
 * seats open, or bulk-rejected when the cohort fills). Already-decided
 * rows are returned in `skipped` so the reviewer knows they weren't
 * silently no-op'd.
 */
export async function bulkDecideApplications(input: {
  applicationIds: string[];
  decision: "accepted" | "rejected" | "waitlisted";
  notes: string;
}): Promise<{ succeeded: number; failed: number; skipped: number }> {
  await assertPermission("applications.review");
  if (!input.applicationIds.length) {
    return { succeeded: 0, failed: 0, skipped: 0 };
  }
  // Hard cap so a reviewer who select-alls a thousand rows by accident
  // can't kick off a fan-out that takes minutes. 100 is generous for a
  // typical batch.
  if (input.applicationIds.length > 100) {
    throw new Error("Too many applications selected (max 100).");
  }

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("applications")
    .select("id, status")
    .in("id", input.applicationIds);
  if (fetchErr) throw new Error(fetchErr.message);

  const decidable = new Set(
    (existing ?? [])
      .filter(
        (a: any) =>
          a.status === "submitted" ||
          a.status === "draft" ||
          a.status === "waitlisted",
      )
      .map((a: any) => a.id as string),
  );
  const skipped = input.applicationIds.length - decidable.size;

  let succeeded = 0;
  let failed = 0;
  for (const id of input.applicationIds) {
    if (!decidable.has(id)) continue;
    try {
      await decideApplication(id, input.decision, input.notes);
      succeeded++;
    } catch (err) {
      console.error("[applications] bulk decide failed for", id, err);
      failed++;
    }
  }

  await logAudit({
    action: `application.bulk_${input.decision}`,
    targetType: "application",
    payload: {
      requested: input.applicationIds.length,
      succeeded,
      failed,
      skipped,
    },
  });

  revalidatePath("/admin/applications");
  revalidatePath("/admin");
  return { succeeded, failed, skipped };
}

export async function reopenApplication(applicationId: string) {
  await assertPermission("applications.review");
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

/**
 * Waive the enrollment fee for an accepted student. Marks fee_waived,
 * enrolls them in the cohort, sends email + notification.
 */
export async function waiveApplicationFee(
  applicationId: string,
  reason: string,
) {
  const { userId: actorId } = await assertPermission("charges.manage");
  const admin = createAdminClient();

  const { data: app, error: fetchErr } = await admin
    .from("applications")
    .select(
      "id, status, user_id, cohort_id, fee_waived, full_name, cohort:cohorts(name), profile:profiles!applications_user_id_fkey(email, full_name)",
    )
    .eq("id", applicationId)
    .single();
  if (fetchErr || !app) throw new Error(fetchErr?.message ?? "Not found");
  if (app.fee_waived) throw new Error("Fee is already waived.");
  if (app.status === "rejected") throw new Error("Application was rejected.");

  await admin
    .from("applications")
    .update({
      fee_waived: true,
      fee_waiver_reason: reason?.trim() || null,
      fee_waived_by: actorId,
      fee_waived_at: new Date().toISOString(),
      status: "enrolled",
      paid_at: new Date().toISOString(),
    })
    .eq("id", applicationId);

  if (app.cohort_id) {
    await admin.from("enrollments").upsert(
      {
        user_id: app.user_id,
        cohort_id: app.cohort_id,
        application_id: applicationId,
      },
      { onConflict: "user_id,cohort_id" },
    );
  }

  await logAudit({
    action: "application.fee_waived",
    targetType: "application",
    targetId: applicationId,
    payload: { reason: reason || null },
  });

  try {
    const a = app as any;
    const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
    const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    await notify({
      userId: app.user_id,
      type: "application_fee_waived",
      title: "Your enrollment fee has been waived",
      body: `Welcome to ${cohort?.name ?? "batch0"} — you're enrolled.`,
      link: "/dashboard/course",
    });
    if (profile?.email) {
      const html = `<!doctype html><html><body style="background:#0a0a0a;color:#e7e7e7;font-family:Inter,Arial,sans-serif;margin:0;padding:32px">
        <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px">
          <div style="font-weight:700"><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">batch<span style="color:#ffbb00">0</span></span></div>
          <h1 style="font-size:22px;color:#ffbb00;margin-top:18px">Fee waived — you're in</h1>
          <p>Welcome to <strong>${escapeHtml(cohort?.name ?? "batch0")}</strong>${a.full_name ? `, ${escapeHtml(a.full_name)}` : ""}. We've waived the enrollment fee${reason?.trim() ? ` (${escapeHtml(reason.trim())})` : ""} and your course access is unlocked.</p>
          <p><a href="https://batch0.org/dashboard/course" style="display:inline-block;background:#ffbb00;color:#000;padding:10px 18px;border-radius:8px;font-weight:600;text-decoration:none">Open your course</a></p>
        </div>
      </body></html>`;
      await sendEmail({
        to: profile.email,
        subject: "Your batch0 enrollment fee was waived",
        html,
      });
    }
  } catch (err) {
    console.error("[applications] waive notify failed", err);
  }

  // If the user has linked Discord, sync their roles now that they're
  // fully enrolled. Tolerant of a missing 0008 migration.
  try {
    const discord = await loadDiscordHandle(admin, app.user_id);
    if (discord?.discord_user_id) {
      await syncMemberRoles(
        discord.discord_user_id,
        (discord.role as any) ?? "student",
      );
    }
  } catch (err) {
    console.error("[applications] waive discord sync failed", err);
  }

  revalidatePath(`/admin/applications/${applicationId}`);
  revalidatePath("/admin/applications");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/application");
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pull the user's Discord handle + role for downstream sync. Returns
 * null if the Discord columns don't exist yet (migration 0008 not
 * applied), so the caller can no-op cleanly.
 */
async function loadDiscordHandle(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{ discord_user_id: string | null; role: string | null } | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("discord_user_id, role")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    // "column does not exist" -> 0008 not applied. Quietly skip.
    if ((error as any).code === "42703") return null;
    throw error;
  }
  return (data as any) ?? null;
}
