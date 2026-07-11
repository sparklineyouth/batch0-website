import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Course content</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Manage modules and lessons. Upload videos directly in the Supabase
            Storage UI under{" "}
            <span className="text-ink-soft">course-videos</span>, then paste the
            path here.
          </p>
        </div>
        <Link href="/admin/course/analytics">
          <Button variant="secondary" size="sm">
            Analytics →
          </Button>
        </Link>
      </div>

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
