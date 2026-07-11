import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { CohortsManager } from "./cohorts-manager";

export const metadata = { title: "Cohorts · Admin" };

export default async function AdminCohortsPage() {
  const admin = createAdminClient();
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

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Cohorts</h1>
      <p className="mt-1 text-sm text-ink-faint">Create and manage cohort runs.</p>

      <Card className="mt-6">
        <CohortsManager initialCohorts={cohorts as any[] ?? []} />
      </Card>
    </div>
  );
}
