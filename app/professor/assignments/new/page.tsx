import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { AssignmentForm } from "../assignment-form";

export const metadata = { title: "New assignment · Professor" };

export default async function NewAssignmentPage() {
  const admin = createAdminClient();
  const [{ data: cohorts }, { data: modules }, { data: lessons }] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin.from("modules").select("id, cohort_id, title, week").order("position"),
      admin.from("lessons").select("id, module_id, title").order("position"),
    ]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/professor/assignments"
        className="text-sm text-white/50 hover:text-white"
      >
        ← All assignments
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">
        New assignment
      </h1>
      <Card className="mt-6">
        <AssignmentForm
          initial={{
            cohort_id: cohorts?.[0]?.id ?? "",
            lesson_id: null,
            title: "",
            description: "",
            due_at: null,
          }}
          cohorts={cohorts ?? []}
          modules={modules ?? []}
          lessons={lessons ?? []}
        />
      </Card>
    </div>
  );
}
