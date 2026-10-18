import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { CourseManager } from "./course-manager";

export const metadata = { title: "Course · Admin" };

export default async function AdminCoursePage(props: {
  searchParams: Promise<{ module?: string }>;
}) {
  // ?module=<id> opens that module: the cohort readiness checklist links a
  // missing file or an empty lesson straight to the module that holds it.
  const { module: openModule } = await props.searchParams;
  const admin = createAdminClient();
  const [{ data: cohorts }, { data: modules }, { data: lessons }] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin.from("modules").select("*").order("week").order("position"),
      admin.from("lessons").select("*").order("position"),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Course content</h1>
      <p className="mt-1 text-sm text-ink-faint">Modules and lessons.</p>

      <Card className="mt-6">
        <CourseManager
          cohorts={cohorts ?? []}
          modules={modules ?? []}
          lessons={lessons ?? []}
          initialOpenModuleId={typeof openModule === "string" ? openModule : null}
        />
      </Card>
    </div>
  );
}
