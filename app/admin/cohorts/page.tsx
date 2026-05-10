import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { CohortsManager } from "./cohorts-manager";

export const metadata = { title: "Cohorts · Admin" };

export default async function AdminCohortsPage() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin
    .from("cohorts")
    .select("*, enrollments(count)")
    .order("starts_on", { ascending: true });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Cohorts</h1>
      <p className="mt-1 text-sm text-white/50">Create and manage cohort runs.</p>

      <Card className="mt-6">
        <CohortsManager initialCohorts={cohorts as any[] ?? []} />
      </Card>
    </div>
  );
}
