import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { getApplicationForm } from "@/lib/application-questions";
import {
  getScholarshipInterestQuestions,
  listScholarships,
  describeAward,
} from "@/lib/scholarships";
import { can } from "@/lib/permissions";
import { QuestionEditor } from "./question-editor";
import {
  ScholarshipQuestionsEditor,
  type ScholarshipChoice,
} from "./scholarship-questions";

export const metadata = { title: "Application form · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminApplicationQuestionsPage() {
  const viewer = await requirePermission("applications.form");

  // The scholarship section is gated separately: editing the questions that
  // decide who gets money is a scholarship power, and the save action asserts
  // `scholarships.manage` regardless of what this page renders.
  const canManageScholarships = can(viewer.caps, "scholarships.manage");

  const admin = createAdminClient();
  const [form, shared, { scholarships }] = await Promise.all([
    getApplicationForm(),
    getScholarshipInterestQuestions(),
    canManageScholarships
      ? listScholarships(admin)
      : Promise.resolve({ scholarships: [], missingTable: false }),
  ]);

  const choices: ScholarshipChoice[] = scholarships.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    kind: s.kind,
    awardSummary: describeAward(s.terms),
    enabled: s.enabled,
    questions: s.questions,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Application form</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Everything an applicant is asked. Edit the wording of any question, add
        your own, and remove the ones you don't want. Changes apply to every
        applicant who hasn't submitted yet.
      </p>

      <Card className="mt-6">
        <QuestionEditor initial={form.builtins} initialCustom={form.custom} />
      </Card>

      {canManageScholarships && (
        <>
          <h2 className="mt-12 text-2xl font-bold tracking-tight">
            Scholarship questions
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Kept separate from the application above because they're asked at a
            different moment, of different people. Pick which scholarship you're
            editing.
          </p>
          <Card className="mt-6">
            <ScholarshipQuestionsEditor
              initialShared={shared}
              scholarships={choices}
            />
          </Card>
        </>
      )}
    </div>
  );
}
