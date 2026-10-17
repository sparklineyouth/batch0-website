import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth";
import { CohortsManager } from "./cohorts-manager";
import { loadPromoConfig } from "@/lib/promo-settings";
import { loadCohortReadiness } from "@/lib/cohort-readiness-server";

export const metadata = { title: "Cohorts · Admin" };

export default async function AdminCohortsPage() {
  // The layout already gates /admin/cohorts on cohorts.manage; this hands the
  // checklist the viewer's permissions, so it links only to editors they can
  // open (Course, Events and Assignments each have their own).
  const viewer = await requirePermission("cohorts.manage");
  const admin = createAdminClient();
  const promoConfig = await loadPromoConfig();
  // Order by cohort_number when the column exists (migration 0017),
  // otherwise fall back to chronological order so the page still
  // renders pre-migration.
  let { data: cohorts, error } = await admin
    .from("cohorts")
    .select("*, enrollments(count)")
    .order("cohort_number", { ascending: true, nullsFirst: false });
  if (error && /column .*cohort_number.* does not exist/i.test(error.message)) {
    ({ data: cohorts } = await admin
      .from("cohorts")
      .select("*, enrollments(count)")
      .order("starts_on", { ascending: true, nullsFirst: false }));
  }
  // Upcoming and active cohorts only; never throws (see the loader).
  const readiness = await loadCohortReadiness(admin, (cohorts as any[]) ?? [], { caps: viewer.caps });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Cohorts</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Create and manage cohort runs. Readiness checks each upcoming and active cohort&rsquo;s setup.
      </p>

      <Card className="mt-6">
        <CohortsManager
          initialCohorts={cohorts as any[] ?? []}
          promoConfig={promoConfig}
          readiness={readiness}
        />
      </Card>
    </div>
  );
}
