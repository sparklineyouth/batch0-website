"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { QuestionListEditor } from "@/components/admin/question-list-editor";
import { formatAnswer, type CustomQuestion } from "@/lib/question-schema";
import { saveQuestionsForScholarship } from "../actions";

export function ScholarshipQuestionsPanel({
  scholarshipId,
  initial,
  readOnly = false,
}: {
  scholarshipId: string;
  initial: CustomQuestion[];
  readOnly?: boolean;
}) {
  const [questions, setQuestions] = useState<CustomQuestion[]>(initial);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  if (readOnly) {
    const live = questions.filter((q) => !q.hidden);
    if (live.length === 0) {
      return (
        <p className="text-sm text-ink-soft">
          No extra questions on this scholarship.
        </p>
      );
    }
    return (
      <ol className="space-y-3">
        {live.map((q) => (
          <li key={q.id} className="border-b border-line pb-3 last:border-0">
            <p className="text-sm text-ink">
              {q.label}
              {q.required && <span className="text-phosphor-ink"> *</span>}
            </p>
            {q.help && <p className="mt-0.5 text-xs text-ink-soft">{q.help}</p>}
            <p className="mt-1 text-xs text-ink-faint">
              <code>{q.id}</code> · {q.type}
              {q.options.length > 0 &&
                ` · ${q.options.map((o) => o.label).join(", ")}`}
            </p>
          </li>
        ))}
      </ol>
    );
  }

  function onSave() {
    setError(undefined);
    start(async () => {
      try {
        const res = await saveQuestionsForScholarship(scholarshipId, questions);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="space-y-5">
      <QuestionListEditor
        questions={questions}
        onChange={(next) => {
          setQuestions(next);
          setSaved(false);
        }}
        emptyHint="No extra questions yet. Without any, applying is a single button — which is right for some scholarships."
      />

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save questions"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </div>
  );
}
