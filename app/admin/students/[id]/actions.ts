"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { kickFromGuild, removeRoleFromMember, getDiscordSettings } from "@/lib/discord";

async function fetchTargetProfile(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, full_name, role, discord_user_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("User not found");
  return data;
}

/**
 * Withdraw a student from the program: mark their latest application
 * `withdrawn`, drop their enrollment, notify + email them. Reversible
 * by re-accepting them or moving them back into a cohort.
 */
export async function removeFromProgram(userId: string, reason: string) {
  const { userId: actorId } = await assertAdmin();
  if (userId === actorId) throw new Error("Use a separate admin to remove yourself.");
  const target = await fetchTargetProfile(userId);

  const admin = createAdminClient();

  // Latest application -> withdrawn.
  const { data: app } = await admin
    .from("applications")
    .select("id, cohort_id, status")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (app) {
    await admin
      .from("applications")
      .update({
        status: "withdrawn",
        review_notes: reason?.trim() || null,
      })
      .eq("id", app.id);
  }

  // Drop all enrollments.
  await admin.from("enrollments").delete().eq("user_id", userId);

  // Strip SparkLine-managed Discord roles. We keep them on the server
  // (use Delete account to fully remove) but they lose access to
  // role-gated channels.
  if (target.discord_user_id) {
    try {
      const settings = await getDiscordSettings();
      for (const rid of Object.values(settings.roleIdByRole)) {
        if (rid) await removeRoleFromMember(target.discord_user_id, rid);
      }
    } catch (err) {
      console.error("[remove] discord role strip failed", err);
    }
  }

  await logAudit({
    action: "user.removed_from_program",
    targetType: "profile",
    targetId: userId,
    payload: {
      email: target.email,
      reason: reason?.trim() || null,
      cohort_id: app?.cohort_id ?? null,
    },
  });

  await notify({
    userId,
    type: "removed_from_program",
    title: "You've been removed from the program",
    body: reason?.trim() ||
      "An admin has removed you from your cohort. Please reach out if you think this is a mistake.",
    link: "/dashboard",
  });
  if (target.email) {
    const html = `<!doctype html><html><body style="background:#0a0a0a;color:#e7e7e7;font-family:Inter,Arial,sans-serif;margin:0;padding:32px">
      <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px">
        <div style="font-weight:700">Spark<span style="color:#facc15">Line</span></div>
        <h1 style="font-size:20px;color:#fff;margin-top:16px">You've been removed from your cohort</h1>
        <p style="color:#bbb">An admin has withdrawn your participation in SparkLine.${reason?.trim() ? ` Reason: <em>${escapeHtml(reason.trim())}</em>.` : ""}</p>
        <p style="color:#bbb">If you believe this is an error, reply to this email or write to <a style="color:#facc15" href="mailto:${env.contactEmail}">${env.contactEmail}</a>.</p>
      </div>
    </body></html>`;
    await sendEmail({
      to: target.email,
      subject: "You've been removed from your SparkLine cohort",
      html,
    });
  }

  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/applications");
  revalidatePath("/admin");
}

/**
 * Move a student to a different cohort. Updates their latest active
 * application + replaces the enrollment row.
 */
export async function moveToCohort(userId: string, cohortId: string) {
  const { userId: actorId } = await assertAdmin();
  if (!cohortId) throw new Error("Pick a cohort");
  const target = await fetchTargetProfile(userId);

  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select("id, name")
    .eq("id", cohortId)
    .maybeSingle();
  if (!cohort) throw new Error("Cohort not found");

  const { data: app } = await admin
    .from("applications")
    .select("id, cohort_id, status")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (app) {
    await admin
      .from("applications")
      .update({ cohort_id: cohortId })
      .eq("id", app.id);
  }

  // Drop existing enrollments (any cohort) and recreate against the
  // new one if the application is paid/enrolled.
  await admin.from("enrollments").delete().eq("user_id", userId);
  if (app && (app.status === "paid" || app.status === "enrolled")) {
    await admin.from("enrollments").insert({
      user_id: userId,
      cohort_id: cohortId,
      application_id: app.id,
    });
  }

  await logAudit({
    action: "user.moved_to_cohort",
    targetType: "profile",
    targetId: userId,
    payload: {
      email: target.email,
      from_cohort_id: app?.cohort_id ?? null,
      to_cohort_id: cohortId,
      actor_id: actorId,
    },
  });

  await notify({
    userId,
    type: "moved_to_cohort",
    title: `Moved to ${cohort.name}`,
    body: "An admin has moved you to a different cohort.",
    link: "/dashboard",
  });

  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/applications");
}

/**
 * Send a password-reset email to the user. Uses the public anon
 * endpoint via the admin client (Supabase routes the reset itself —
 * we just trigger it).
 */
export async function sendPasswordResetForUser(userId: string) {
  await assertAdmin();
  const target = await fetchTargetProfile(userId);
  if (!target.email) throw new Error("User has no email on file");

  const admin = createAdminClient();
  const { error } = await admin.auth.resetPasswordForEmail(target.email, {
    redirectTo: `${env.siteUrl}/reset`,
  });
  if (error) throw new Error(error.message);

  await logAudit({
    action: "user.password_reset_sent",
    targetType: "profile",
    targetId: userId,
    payload: { email: target.email },
  });
}

/**
 * Hard-delete the user from Supabase auth. Cascades through
 * `profiles` (FK on delete cascade) and dependent rows.
 */
export async function deleteUserAccount(userId: string, reason: string) {
  const { userId: actorId } = await assertAdmin();
  if (userId === actorId) throw new Error("You can't delete your own account.");
  const target = await fetchTargetProfile(userId);
  if (target.role === "admin") {
    throw new Error("Demote the user from admin before deleting.");
  }

  const admin = createAdminClient();

  // Kick from Discord first (best-effort) — once we delete the auth
  // user, we lose their discord_user_id.
  if (target.discord_user_id) {
    await kickFromGuild(target.discord_user_id).catch(() => {});
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "user.deleted",
    targetType: "profile",
    targetId: userId,
    payload: {
      email: target.email,
      full_name: target.full_name,
      reason: reason?.trim() || null,
    },
  });

  revalidatePath("/admin/students");
  revalidatePath("/admin/applications");
  revalidatePath("/admin");
}

/**
 * Refund the user's most recent succeeded enrollment payment via
 * Stripe, mark the payment row refunded, set the application back to
 * `accepted` so they can re-pay (or be removed separately).
 */
export async function refundLatestPayment(userId: string, reason: string) {
  await assertAdmin();
  const target = await fetchTargetProfile(userId);

  const admin = createAdminClient();
  const { data: payment } = await admin
    .from("payments")
    .select("id, stripe_payment_intent_id, application_id, amount_cents")
    .eq("user_id", userId)
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!payment) throw new Error("No succeeded payment to refund");
  if (!payment.stripe_payment_intent_id) {
    throw new Error("Payment is missing the Stripe intent id");
  }

  await stripe.refunds.create({
    payment_intent: payment.stripe_payment_intent_id,
    reason: "requested_by_customer",
    metadata: {
      sparkline_user_id: userId,
      sparkline_reason: reason?.trim() || "admin_refund",
    },
  });

  await admin
    .from("payments")
    .update({ status: "refunded" })
    .eq("id", payment.id);

  if (payment.application_id) {
    await admin
      .from("applications")
      .update({ status: "accepted", paid_at: null })
      .eq("id", payment.application_id);
    await admin
      .from("enrollments")
      .delete()
      .eq("application_id", payment.application_id);
  }

  await logAudit({
    action: "payment.refunded_by_admin",
    targetType: "payment",
    targetId: payment.id,
    payload: {
      user_id: userId,
      email: target.email,
      amount_cents: payment.amount_cents,
      reason: reason?.trim() || null,
    },
  });

  await notify({
    userId,
    type: "payment_refunded",
    title: "Payment refunded",
    body: `An admin has issued a refund for $${(payment.amount_cents / 100).toFixed(2)}.`,
    link: "/dashboard/billing",
  });

  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/payments");
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
