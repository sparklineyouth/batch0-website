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

  // Tell the investor we acted on their request.
  if (existing.status !== input.status) {
    try {
      const { data: team } = await admin
        .from("teams")
        .select("name")
        .eq("id", existing.team_id)
        .maybeSingle();
      await notify({
        userId: existing.investor_id,
        type: "intro_status_update",
        title: `Intro update: ${team?.name ?? "team"}`,
        body: `Status is now "${input.status.replace(/_/g, " ")}".`,
        link: "/investor/intros",
      });
    } catch {}
  }

  revalidatePath("/admin/intros");
  revalidatePath("/investor/intros");
}
