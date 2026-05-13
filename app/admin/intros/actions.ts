"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";

const ALLOWED = [
  "requested",
  "intro_made",
  "meeting_held",
  "committed",
  "wired",
  "passed",
] as const;

export async function updateIntroStatus(input: {
  introId: string;
  status: (typeof ALLOWED)[number];
  adminNotes?: string | null;
}) {
  await assertAdmin();
  if (!ALLOWED.includes(input.status)) {
    throw new Error("Invalid status");
  }
  const admin = createAdminClient();
  const patch: Record<string, any> = { status: input.status };
  if (input.adminNotes !== undefined) {
    patch.admin_notes = (input.adminNotes ?? "").trim().slice(0, 2000) || null;
  }
  const { data: existing } = await admin
    .from("intro_requests")
    .select("investor_id, team_id, status")
    .eq("id", input.introId)
    .single();
  if (!existing) throw new Error("Not found");

  const { error } = await admin
    .from("intro_requests")
    .update(patch)
    .eq("id", input.introId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "intro_request.updated",
    targetType: "intro_request",
    targetId: input.introId,
    payload: { from: existing.status, to: input.status },
  });

  // Notify everyone touched by this transition: the investor (so they
  // know we acted on their request) and every team member (so the
  // students see momentum on their dashboard). Statuses worth shouting
  // about for the team are 'intro_made' (a real intro just happened),
  // 'committed', and 'wired' (money landed). The rest still notify but
  // with quieter copy.
  if (existing.status !== input.status) {
    try {
      const [{ data: team }, { data: members }] = await Promise.all([
        admin
          .from("teams")
          .select("name")
          .eq("id", existing.team_id)
          .maybeSingle(),
        admin
          .from("team_members")
          .select("user_id")
          .eq("team_id", existing.team_id),
      ]);
      const teamName = team?.name ?? "team";
      const prettyStatus = input.status.replace(/_/g, " ");

      // Investor notification.
      await notify({
        userId: existing.investor_id,
        type: "intro_status_update",
        title: `Intro update: ${teamName}`,
        body: `Status is now "${prettyStatus}".`,
        link: "/investor/intros",
      });

      // Team member notifications — only on milestone transitions so
      // we don't spam them on every internal admin status nudge.
      const teamMilestones = new Set([
        "intro_made",
        "committed",
        "wired",
        "passed",
      ]);
      if (teamMilestones.has(input.status)) {
        const { data: investor } = await admin
          .from("profiles")
          .select("full_name, email")
          .eq("id", existing.investor_id)
          .maybeSingle();
        const investorName =
          investor?.full_name ?? investor?.email ?? "An investor";

        const titleByStatus: Record<string, string> = {
          intro_made: `${investorName} was introduced to your team`,
          committed: `${investorName} committed to invest`,
          wired: `Investment wired by ${investorName} 🎉`,
          passed: `${investorName} passed for now`,
        };
        const bodyByStatus: Record<string, string> = {
          intro_made:
            "Reach out to schedule a meeting if you haven't already.",
          committed:
            "Great news — the investor is in. Coordinate paperwork next.",
          wired:
            "Funds have been sent. Confirm receipt and follow up with a thank-you.",
          passed:
            "Worth a short follow-up to keep the relationship warm.",
        };

        for (const m of members ?? []) {
          await notify({
            userId: m.user_id,
            type: "intro_status_update",
            title: titleByStatus[input.status],
            body: bodyByStatus[input.status],
            link: "/dashboard/intros",
          });
        }
      }
    } catch (err) {
      console.error("[intros] notify failed", err);
    }
  }

  revalidatePath("/admin/intros");
  revalidatePath("/investor/intros");
  revalidatePath("/dashboard/intros");
  revalidatePath("/dashboard");
}
