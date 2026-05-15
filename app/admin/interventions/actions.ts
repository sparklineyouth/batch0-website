"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export async function resolveIntervention(id: string) {
  await assertAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("at_risk_interventions")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "at_risk.resolved",
    targetType: "at_risk_intervention",
    targetId: id,
  });
  revalidatePath("/admin/interventions");
}
