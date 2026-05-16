"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { issueCertificate } from "@/lib/cert";
import { notify } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

/**
 * Bulk-issues a completion certificate for every enrolled student in a
 * cohort. Idempotent. Returns the count of new certs issued.
 */
export async function issueCohortCertificates(input: {
  cohortId: string;
}): Promise<{ issued: number }> {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("enrollments")
    .select("user_id")
    .eq("cohort_id", input.cohortId);
  if (!rows || rows.length === 0) return { issued: 0 };

  let issued = 0;
  for (const r of rows) {
    const { data: existing } = await admin
      .from("certificates")
      .select("id")
      .eq("user_id", r.user_id)
      .eq("cohort_id", input.cohortId)
      .maybeSingle();
    if (existing) continue;
    const cert = await issueCertificate({
      userId: r.user_id,
      cohortId: input.cohortId,
    });
    issued++;
    await notify({
      userId: r.user_id,
      type: "certificate_issued",
      title: "Your SparkLine Youth certificate is ready",
      body: "Tap to view + share.",
      link: `/verify/${cert.code}`,
    });
  }
  await logAudit({
    action: "certificates.bulk_issued",
    targetType: "cohort",
    targetId: input.cohortId,
    payload: { issued, total: rows.length },
  });
  revalidatePath("/admin/cohorts");
  return { issued };
}
