import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { CourseManager } from "@/app/admin/course/course-manager";

export const metadata = { title: "Course · Mentor" };

export default async function MentorCoursePage() {
  const admin = createAdminClient();
  const [{ data: cohorts }, { data: modules }, { data: lessons }] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin.from("modules").select("*").order("position"),
      admin.from("lessons").select("*").order("position"),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Course content</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Manage modules and lessons. Upload videos and materials directly
        below; students enrolled in the matching cohort see them.
      </p>

      <Card className="mt-6">
        <CourseManager
          cohorts={cohorts ?? []}
          modules={modules ?? []}
          lessons={lessons ?? []}
        />
      </Card>
    </div>
  );
}
