"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getActionError } from "@/lib/action-error";
import {
  CustomQuestionFields,
  seedAnswers,
  type AnswerState,
} from "@/components/forms/custom-question-fields";
import {
  checkAnswers,
  readAnswers,
  CUSTOM_PREFIX,
  type CustomQuestion,
} from "@/lib/question-schema";
import { saveScholarshipApplicationAction } from "../actions";

/**
 * The scholarship application form.
 *
 * Renders whatever questions the admin attached to this scholarship — a merit
 * award's extra questions, a need-based award's circumstances, or nothing at
 * all. A scholarship with no questions is legitimate and common (the learner's
 * grant may just want a sentence), so the empty case submits cleanly rather
 * than showing an empty box.
 *
 * Validated through the SAME checkAnswers the server action runs, against the
 * same question list. Anything the client lets through the server would reject
 * is a bug that surfaces as a silent bounce, so the two use one implementation.
 */
export function ScholarshipApplyForm({
  slug,
  questions,
  saved,
  awardSummary,
}: {
  slug: string;
  questions: CustomQuestion[];
  saved: Record<string, unknown> | null;
  awardSummary: string;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<AnswerState>(() =>
    seedAnswers(questions, CUSTOM_PREFIX, saved),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [savedNote, setSavedNote] = useState(false);
  const [pending, start] = useTransition();

  function set(name: string, value: string) {
    setAnswers((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: "" }));
    setSavedNote(false);
  }

  function submit(doSubmit: boolean) {
    setError(undefined);
    setErrors({});

    const bare = readAnswers(questions, answers, CUSTOM_PREFIX);

    if (doSubmit) {
      const checked = checkAnswers(questions, bare);
      if (!checked.ok) {
        const mapped: Record<string, string> = {};
        for (const [id, msg] of Object.entries(checked.errors)) {
          mapped[`${CUSTOM_PREFIX}__${id}`] = msg;
        }
        setErrors(mapped);
        setError("Please fix the highlighted questions.");
        return;
      }
    }

    start(async () => {
      try {
        const res = await saveScholarshipApplicationAction({
          slug,
          answers: bare,
          submit: doSubmit,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const outcome = res.data!;
        if (!outcome.saved) {
          setError(outcome.error);
          const mapped: Record<string, string> = {};
          for (const [id, msg] of Object.entries(outcome.fieldErrors)) {
            mapped[`${CUSTOM_PREFIX}__${id}`] = msg;
          }
          setErrors(mapped);
          return;
        }
        if (outcome.submitted) {
          router.push("/dashboard/scholarships");
          router.refresh();
        } else {
          setSavedNote(true);
        }
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Apply</h2>
      <p className="mt-1 text-sm text-ink-soft">
        {questions.length > 0
          ? "A few questions, then we read it by hand. Take your time — you can save and come back."
          : "Nothing to fill in for this one. Submitting puts you in front of the team."}
      </p>

      {questions.length > 0 && (
        <div className="mt-6 space-y-5">
          <CustomQuestionFields
            questions={questions}
            prefix={CUSTOM_PREFIX}
            values={answers}
            onChange={set}
            errors={errors}
          />
        </div>
      )}

      {error && (
        <p className="mt-5 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button disabled={pending} onClick={() => submit(true)}>
          {pending ? "Submitting…" : "Submit application"}
        </Button>
        {questions.length > 0 && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => submit(false)}
          >
            Save for later
          </Button>
        )}
        {savedNote && (
          <span className="text-xs text-emerald-500">
            Saved. Come back any time.
          </span>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-faint">
        Worth {awardSummary}. You can hold one batch0 scholarship at a time, so
        applying here means waiting on this decision before applying elsewhere.
      </p>
    </Card>
  );
}
