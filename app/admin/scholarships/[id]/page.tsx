import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { getScholarshipById, describeAward } from "@/lib/scholarships";
import { ScholarshipForm, scholarshipToForm } from "../scholarship-form";
import { ScholarshipQuestionsPanel } from "./questions-panel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const s = await getScholarshipById(createAdminClient(), id);
  return { title: `${s?.name ?? "Scholarship"} · Admin` };
}

export default async function EditScholarshipPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const viewer = await requirePermission("scholarships.view");
  const canManage = can(viewer.caps, "scholarships.manage");

  const admin = createAdminClient();
  const scholarship = await getScholarshipById(admin, id);
  if (!scholarship) notFound();

  const { count: awarded } = await admin
    .from("scholarship_applications")
    .select("id", { count: "exact", head: true })
    .eq("scholarship_id", id)
    .eq("status", "awarded");

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/scholarships"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Scholarships
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">
        {scholarship.name}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        {describeAward(scholarship.terms)} · {awarded ?? 0} awarded ·{" "}
        <Link
          href={`/admin/scholarships/applications?scholarship=${scholarship.id}`}
          className="underline hover:no-underline"
        >
          see applications
        </Link>
      </p>

      {!canManage && (
        <Card className="mt-6 border-amber-400/30 bg-amber-400/5">
          <p className="text-sm text-amber-300">
            You can read this but not change it — that needs the "Award
            scholarships" permission.
          </p>
        </Card>
      )}

      {(awarded ?? 0) > 0 && canManage && (
        <Card className="mt-6 border-amber-400/30 bg-amber-400/5">
          <p className="text-sm text-amber-300">
            {awarded} {awarded === 1 ? "student holds" : "students hold"} this
            already. Editing what it's worth only affects awards made from now
            on — each award snapshots its value when it's granted, so nobody's
            existing scholarship changes under them.
          </p>
        </Card>
      )}

      {canManage && (
        <Card className="mt-6">
          <ScholarshipForm initial={scholarshipToForm(scholarship)} />
        </Card>
      )}

      <h2 className="mt-12 text-2xl font-bold tracking-tight">
        Its questions
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Asked only of students applying for this scholarship, after they've been
        accepted. This is where merit questions go. They're also editable from{" "}
        <Link
          href="/admin/application-questions"
          className="underline hover:no-underline"
        >
          the application form page
        </Link>
        .
      </p>
      <Card className="mt-6">
        <ScholarshipQuestionsPanel
          scholarshipId={scholarship.id}
          initial={scholarship.questions}
          readOnly={!canManage}
        />
      </Card>
    </div>
  );
}
