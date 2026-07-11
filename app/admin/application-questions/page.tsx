import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { getApplicationQuestions } from "@/lib/application-questions";
import { QuestionEditor } from "./question-editor";

export const metadata = { title: "Application form · Admin" };

export default async function AdminApplicationQuestionsPage() {
  await requireAdmin();
  const questions = await getApplicationQuestions();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Application form</h1>
      <p className="mt-1 text-sm text-white/50">
        Edit the wording of each application question. You can change labels,
        help text, placeholders, and which fields are required or hidden — but
        not add, remove, or reorder fields. Changes apply to every applicant who
        hasn't been accepted yet.
      </p>

      <Card className="mt-6">
        <QuestionEditor initial={questions} />
      </Card>
    </div>
  );
}
