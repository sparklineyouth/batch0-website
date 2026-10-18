"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, assertPermission } from "@/lib/server-guards";
import { capabilitiesForRole } from "@/lib/roles";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { stripe } from "@/lib/stripe";
import { handleChargeRefunded } from "@/lib/stripe-fulfillment";
import { purgeChatContentFor } from "@/lib/chat-purge";
import { env } from "@/lib/env";
import { isMissingSchemaError } from "@/lib/schema-ready";
import {
  COHORT_MOVE_NOT_READY,
  cohortMoveFailureMessage,
  cohortMoveRefusalMessage,
  parseCohortMoveResult,
} from "@/lib/cohort-move";
import { PROFILE_ACTION_PERMISSIONS } from "@/lib/people-profile-access";
import type { ActionResult } from "@/lib/action-result";

async function fetchTargetProfile(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, full_name, role")
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
  const { userId: actorId } = await assertPermission(PROFILE_ACTION_PERMISSIONS.removeFromProgram);
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
        <div style="font-weight:700"><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">batch<span style="color:#ffbb00">0</span></span></div>
        <h1 style="font-size:20px;color:#fff;margin-top:16px">You've been removed from your cohort</h1>
        <p style="color:#bbb">An admin has withdrawn your participation in batch0.${reason?.trim() ? ` Reason: <em>${escapeHtml(reason.trim())}</em>.` : ""}</p>
        <p style="color:#bbb">If you believe this is an error, reply to this email or write to <a style="color:#ffbb00" href="mailto:${env.contactEmail}">${env.contactEmail}</a>.</p>
      </div>
    </body></html>`;
    await sendEmail({
      to: target.email,
      subject: "You've been removed from your batch0 cohort",
      html,
    });
  }

  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/applications");
  revalidatePath("/admin");
}

/**
 * Move a student to a different cohort: their enrollment, the application it
 * belongs to, and their live scholarship rows, as one transaction in the
 * database (admin_move_student_cohort, migration 0103 — the file explains
 * what moves and what deliberately doesn't).
 *
 * This used to be five separate writes from here, including "delete every
 * enrollment, then insert one back if the latest application is paid". A
 * student added with "Add a person" has no application, so they were left
 * with no enrollment at all; so was anyone whose newest application was a
 * draft; and a failed insert (a full cohort) still reported success. Now a
 * refusal or a failed write changes nothing, and the audit row and the
 * student's notification are written only after the move has committed.
 *
 * `fromCohortId` is the cohort the profile showed them in. If they're no
 * longer there (someone else moved them), nothing moves.
 *
 * Picking the cohort a student has paid for when they're enrolled nowhere
 * (what the old action's failed insert left behind) restores that enrollment
 * rather than refusing with "already in": `data.restored` says which it was,
 * and the student is told their place is back, not that they moved.
 *
 * Returns a result rather than throwing for the refusals an admin has to act
 * on, because a thrown message is replaced with a generic one in production
 * builds (lib/action-result.ts).
 */
export async function moveToCohort(
  userId: string,
  cohortId: string,
  fromCohortId: string | null = null,
): Promise<ActionResult<{ restored: boolean }>> {
  const { userId: actorId } = await assertPermission(PROFILE_ACTION_PERMISSIONS.moveCohort);
  if (!cohortId) return { ok: false, error: "Pick a cohort." };
  const target = await fetchTargetProfile(userId);

  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select("id, name")
    .eq("id", cohortId)
    .maybeSingle();
  if (!cohort) return { ok: false, error: "That cohort doesn't exist." };

  const { data, error } = await admin.rpc("admin_move_student_cohort", {
    p_user_id: userId,
    p_to_cohort_id: cohortId,
    p_from_cohort_id: fromCohortId || null,
  });
  if (error) {
    // Deployed before 0103 ran: refuse plainly rather than fall back to the
    // old writes, which are the bug.
    if (isMissingSchemaError(error)) return { ok: false, error: COHORT_MOVE_NOT_READY };
    console.error("[moveToCohort] move rolled back:", error.message);
    return { ok: false, error: cohortMoveFailureMessage(error.message, cohort.name) };
  }
  const result = parseCohortMoveResult(data);
  if (!result.ok) return { ok: false, error: cohortMoveRefusalMessage(result, cohort.name) };

  // Committed. Only now does anything outside the database hear about it.
  await logAudit({
    action: "user.moved_to_cohort",
    targetType: "profile",
    targetId: userId,
    payload: {
      email: target.email,
      from_cohort_id: result.fromCohortId,
      to_cohort_id: cohortId,
      application_id: result.applicationId,
      // moved | created (a paid application's missing enrollment, in the new
      // cohort) | restored (the same, put back where it was paid for: from
      // and to are the same cohort) | none
      enrollment: result.enrollment,
      // The cohort the scholarship rows were restamped from, and which ones.
      from_scholarship_cohort:
        result.scholarshipApplicationIds.length > 0 ? result.fromCohortId : null,
      scholarship_application_ids: result.scholarshipApplicationIds,
      actor_id: actorId,
    },
  });

  const restored = result.enrollment === "restored";
  await notify({
    userId,
    type: "moved_to_cohort",
    title: restored ? `You're back in ${cohort.name}` : `Moved to ${cohort.name}`,
    body: restored
      ? "An admin has restored your place in your cohort."
      : "An admin has moved you to a different cohort.",
    link: "/dashboard",
  });

  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/applications");
  if (result.scholarshipApplicationIds.length > 0) revalidatePath("/admin/scholarships/applications");
  return { ok: true, data: { restored } };
}

/**
 * Send a password-reset email to the user. Uses the public anon
 * endpoint via the admin client (Supabase routes the reset itself —
 * we just trigger it).
 */
export async function sendPasswordResetForUser(userId: string) {
  await assertPermission(PROFILE_ACTION_PERMISSIONS.passwordReset);
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
  // Intentionally NOT a delegable permission: this hard-deletes the auth user
  // and cascades through every table that references them.
  if (userId === actorId) throw new Error("You can't delete your own account.");
  const target = await fetchTargetProfile(userId);
  // Any role carrying the wildcard, not just the built-in `admin` slug.
  const targetCaps = await capabilitiesForRole(target.role);
  if (targetCaps.superAdmin) {
    throw new Error("Move the user off a full-access role before deleting.");
  }

  const admin = createAdminClient();

  // Chat keeps a deleted account's messages in everyone else's history
  // (sender_id goes null), so their words, earlier versions and files are
  // blanked first, except what's under a report, which is kept as evidence
  // (the privacy policy says so). Before the auth delete: if it fails, the
  // account is still here and a retry is safe, since the purge is idempotent.
  await purgeChatContentFor(userId);

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
 * Stripe, mark the payment row refunded, withdraw the application only when no replacement payment retains access.
 */
export async function refundLatestPayment(userId: string, reason: string) {
  await assertPermission(PROFILE_ACTION_PERMISSIONS.refund);
  const target = await fetchTargetProfile(userId);

  const admin = createAdminClient();
  const { data: payment } = await admin
    .from("payments")
    .select("id, stripe_payment_intent_id, application_id, amount_cents")
    .eq("user_id", userId)
    .eq("status", "succeeded")
    .not("stripe_payment_intent_id", "is", null)
    .gt("amount_cents", 0)
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!payment) throw new Error("No succeeded payment to refund");
  if (!payment.stripe_payment_intent_id) {
    throw new Error("Payment is missing the Stripe intent id");
  }

  const refund = await stripe.refunds.create({
    payment_intent: payment.stripe_payment_intent_id,
    reason: "requested_by_customer",
    metadata: {
      batch0_user_id: userId,
      batch0_reason: reason?.trim() || "admin_refund",
    },
  });

  const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
  if (!chargeId) throw new Error("Stripe accepted the refund but returned no charge. Reconcile before retrying.");
  // Records the refund and posts its #staff line, as on /admin/payments:
  // once, whether this call or the charge.refunded webhook racing it records
  // it first (lib/stripe-fulfillment.ts).
  await handleChargeRefunded(await stripe.charges.retrieve(chargeId), { silent: true });

  await logAudit({
    action: "payment.refunded_by_admin",
    targetType: "payment",
    targetId: payment.id,
    payload: {
      user_id: userId,
      email: target.email,
      amount_cents: refund.amount,
      reason: reason?.trim() || null,
    },
  });

  await notify({
    userId,
    type: "payment_refunded",
    title: "Payment refunded",
    body: `An admin has issued a refund for ${(refund.amount / 100).toFixed(2)} ${refund.currency.toUpperCase()}.`,
    link: "/dashboard/billing",
  });

  revalidatePath(`/admin/students/${userId}`);
  revalidatePath("/admin/students");
  revalidatePath("/admin/payments");
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
