"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { syncMemberRoles, postChannelMessage, announcementEmbed, getDiscordSettings } from "@/lib/discord";

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
      "id, full_name, user_id, cohort:cohorts(name, price_cents), profile:profiles!applications_user_id_fkey(email, full_name, discord_user_id, role)",
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

  // Discord side-effects (best-effort, only fire on accept). If the
  // applicant has linked their Discord account, sync them to the
  // student role; admins on a separate channel get a heads-up.
  try {
    const a = app as any;
    const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
    if (decision === "accepted") {
      if (profile?.discord_user_id) {
        await syncMemberRoles(profile.discord_user_id, profile.role ?? "student");
      }
      const settings = await getDiscordSettings();
      if (settings.adminFeedChannelId) {
        await postChannelMessage(settings.adminFeedChannelId, {
          embeds: [
            announcementEmbed({
              title: `Accepted: ${a.full_name ?? profile?.full_name ?? profile?.email ?? "applicant"}`,
              body: `Cohort: ${cohort?.name ?? "—"}`,
              link: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/admin/applications/${applicationId}`,
            }),
          ],
        });
      }
    }
  } catch (err) {
    console.error("[applications] discord sync failed", err);
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

/**
 * Waive the enrollment fee for an accepted student. Marks fee_waived,
 * enrolls them in the cohort, sends email + notification.
 */
export async function waiveApplicationFee(
  applicationId: string,
  reason: string,
) {
  const { userId: actorId } = await assertAdmin();
  const admin = createAdminClient();

  const { data: app, error: fetchErr } = await admin
    .from("applications")
    .select(
      "id, status, user_id, cohort_id, fee_waived, full_name, cohort:cohorts(name), profile:profiles!applications_user_id_fkey(email, full_name, discord_user_id, role)",
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
      body: `Welcome to ${cohort?.name ?? "SparkLine"} — you're enrolled.`,
      link: "/dashboard/course",
    });
    if (profile?.email) {
      const html = `<!doctype html><html><body style="background:#0a0a0a;color:#e7e7e7;font-family:Inter,Arial,sans-serif;margin:0;padding:32px">
        <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px">
          <div style="font-weight:700">Spark<span style="color:#facc15">Line</span></div>
          <h1 style="font-size:22px;color:#facc15;margin-top:18px">Fee waived — you're in</h1>
          <p>Welcome to <strong>${escapeHtml(cohort?.name ?? "SparkLine")}</strong>${a.full_name ? `, ${escapeHtml(a.full_name)}` : ""}. We've waived the enrollment fee${reason?.trim() ? ` (${escapeHtml(reason.trim())})` : ""} and your course access is unlocked.</p>
          <p><a href="https://sparklineyouth.org/dashboard/course" style="display:inline-block;background:#facc15;color:#000;padding:10px 18px;border-radius:8px;font-weight:600;text-decoration:none">Open your course</a></p>
        </div>
      </body></html>`;
      await sendEmail({
        to: profile.email,
        subject: "Your SparkLine enrollment fee was waived",
        html,
      });
    }
  } catch (err) {
    console.error("[applications] waive notify failed", err);
  }

  // If the user has linked Discord, sync their roles now that they're
  // fully enrolled.
  try {
    const a = app as any;
    const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
    if (profile?.discord_user_id) {
      await syncMemberRoles(profile.discord_user_id, profile.role ?? "student");
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
