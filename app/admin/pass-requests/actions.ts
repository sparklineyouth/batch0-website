"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { feedbackTopicLabel } from "@/lib/founder-pass-perks";

/**
 * Fulfil a founder-pass feedback credit. Admin-only. A "delivered" status
 * carries the written feedback the holder reads on their pass and triggers an
 * email; "scheduled" acknowledges it (e.g. for a live clinic); "declined" hands
 * the holder's credit back (the one-live partial index excludes declined rows).
 */
export async function fulfillFeedbackRequest(input: {
  requestId: string;
  status: "scheduled" | "delivered" | "declined";
  response: string;
}) {
  const { userId: adminId } = await assertAdmin();
  const admin = createAdminClient();

  const response = (input.response ?? "").trim();
  if (input.status === "delivered" && !response) {
    throw new Error("Write the feedback before marking it delivered.");
  }

  const { data: req, error: fetchErr } = await admin
    .from("founder_pass_feedback_requests")
    .select("id, user_id, topic")
    .eq("id", input.requestId)
    .maybeSingle();
  if (fetchErr || !req) throw new Error(fetchErr?.message ?? "Request not found");

  const { data: profileRow } = await admin
    .from("profiles")
    .select("email, full_name")
    .eq("id", (req as any).user_id)
    .maybeSingle();

  const { error } = await admin
    .from("founder_pass_feedback_requests")
    .update({
      status: input.status,
      response: response || null,
      responded_by: adminId,
      responded_at: new Date().toISOString(),
    })
    .eq("id", input.requestId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: `founder_pass_feedback.${input.status}`,
    targetType: "founder_pass_feedback_request",
    targetId: input.requestId,
  });

  // Tell the holder — in-app always, by email when the feedback is delivered.
  try {
    const r = req as any;
    const profile = profileRow as { email: string | null; full_name: string | null } | null;
    const topicLabel = feedbackTopicLabel(r.topic);
    if (input.status === "delivered") {
      await notify({
        userId: r.user_id,
        type: "founder_pass_feedback_ready",
        title: "Your Founder Pass feedback is ready",
        body: `We've written up feedback on your ${topicLabel.toLowerCase()}.`,
        link: "/pass",
      });
      if (profile?.email) {
        const t = Templates.founderPassFeedbackReady({
          name: profile.full_name ?? null,
          topicLabel,
        });
        await sendEmail({ to: profile.email, subject: t.subject, html: t.html });
      }
    } else if (input.status === "scheduled") {
      await notify({
        userId: r.user_id,
        type: "founder_pass_feedback_scheduled",
        title: "Your feedback credit is scheduled",
        body: "We'll cover it at an upcoming clinic — watch your dashboard.",
        link: "/pass",
      });
    }
  } catch (err) {
    console.error("[pass-requests] notify failed", err);
  }

  revalidatePath("/admin/pass-requests");
}
