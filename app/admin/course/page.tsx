import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { CourseManager } from "./course-manager";

export const metadata = { title: "Course · Admin" };

export default async function AdminCoursePage() {
  const admin = createAdminClient();
  const [{ data: cohorts }, { data: modules }, { data: lessons }] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin.from("modules").select("*").order("position"),
      admin.from("lessons").select("*").order("position"),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Course content</h1>
      <p className="mt-1 text-sm text-white/50">
        Manage modules and lessons. Upload videos directly in the Supabase
        Storage UI under <span className="text-white/70">course-videos</span>,
        then paste the path here.
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
