"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { issueCertificate } from "@/lib/cert";
import { notifyMany, type NotifyArgs } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";

/**
 * Bulk-issues a completion certificate for every enrolled student in a
 * cohort, and notifies each one with a link to their public /verify page.
 *
 * Idempotent on (user_id, cohort_id): students who already hold a
 * certificate for this cohort are skipped and not re-notified, so it is
 * safe to re-run after late enrollments.
 */
export async function issueCohortCertificates(input: {
  cohortId: string;
}): Promise<ActionResult<{ issued: number; skipped: number }>> {
  return runAction({ name: "issueCohortCertificates" }, async () => {
    await assertPermission("cohorts.manage");
    const admin = createAdminClient();

    // One round trip each for the roster and the certificates already
    // issued, then diff in memory — rather than a SELECT per student.
    const [enrolled, issuedAlready] = await Promise.all([
      admin.from("enrollments").select("user_id").eq("cohort_id", input.cohortId),
      admin
        .from("certificates")
        .select("user_id")
        .eq("cohort_id", input.cohortId),
    ]);
    if (enrolled.error) throw new Error(enrolled.error.message);
    if (issuedAlready.error) throw new Error(issuedAlready.error.message);

    const have = new Set((issuedAlready.data ?? []).map((r) => r.user_id));
    const todo = (enrolled.data ?? [])
      .map((r) => r.user_id)
      .filter((id) => !have.has(id));

    if (todo.length === 0) {
      return { issued: 0, skipped: have.size };
    }

    const notifications: NotifyArgs[] = [];
    for (const userId of todo) {
      const cert = await issueCertificate({
        userId,
        cohortId: input.cohortId,
      });
      notifications.push({
        userId,
        type: "certificate_issued",
        title: "Your batch0 certificate is ready",
        body: "Tap to view + share.",
        link: `/verify/${cert.code}`,
      });
    }
    await notifyMany(notifications);

    await logAudit({
      action: "certificates.bulk_issued",
      targetType: "cohort",
      targetId: input.cohortId,
      payload: {
        issued: notifications.length,
        skipped: have.size,
        total: enrolled.data?.length ?? 0,
      },
    });
    revalidatePath("/admin/cohorts");
    return { issued: notifications.length, skipped: have.size };
  });
}
