import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { RubricEditor } from "./rubric-editor";

export const metadata = { title: "Demo Day rubric · Admin" };

export default async function AdminDemoDayRubricPage() {
  await requireAdmin();
  const admin = createAdminClient();
  const [{ data: rows }, { data: cohorts }] = await Promise.all([
    admin
      .from("demo_day_rubric_criteria")
      .select("*")
      .order("position", { ascending: true }),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/demo-day"
        className="text-sm text-white/55 hover:text-white"
      >
        ← Demo Day
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Rubric</h1>
      <p className="mt-1 text-sm text-white/55">
        Per-criterion weights drive the leaderboard. Judges see hints next to
        each criterion while scoring.
      </p>
      <Card className="mt-6">
        <RubricEditor
          initial={(rows ?? []) as any}
          cohorts={(cohorts ?? []) as any}
        />
      </Card>
    </div>
  );
}
