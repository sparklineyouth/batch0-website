"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, ListChecks } from "lucide-react";
import { submitQuizAttempt } from "./quiz-actions";

type Question = {
  id: string;
  question: string;
  options: { id: string; text: string }[];
  correct_option_id: string;
  position: number;
};

export function Quiz({
  quizId,
  lessonId,
  title,
  questions,
  bestScore,
}: {
  quizId: string;
  lessonId: string;
  title: string | null;
  questions: Question[];
  bestScore: { score: number; total: number } | null;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ score: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>();

  function submit() {
    if (Object.keys(answers).length < questions.length) {
      setError("Pick an answer for every question.");
      return;
    }
    setError(undefined);
    start(async () => {
      try {
        const res = await submitQuizAttempt({ quizId, lessonId, answers });
        setResult(res);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function reset() {
    setAnswers({});
    setResult(null);
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/30 p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-spark">
        <ListChecks className="h-4 w-4" />
        {title || "Check yourself"}
      </div>
      {bestScore && !result && (
        <p className="mb-4 text-xs text-white/60">
          Last attempt:{" "}
          <span className="text-white">
            {bestScore.score}/{bestScore.total}
          </span>
        </p>
      )}
      <ol className="space-y-5">
        {questions.map((q, i) => (
          <li key={q.id}>
            <p className="text-sm font-medium text-white">
              {i + 1}. {q.question}
            </p>
            <div className="mt-2 space-y-1.5">
              {q.options.map((o) => {
                const selected = answers[q.id] === o.id;
                const showResult = result !== null;
                const isCorrect = q.correct_option_id === o.id;
                const wasMyChoice = selected;
                return (
                  <label
                    key={o.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                      showResult
                        ? isCorrect
                          ? "border-emerald-400/40 bg-emerald-400/5 text-emerald-200"
                          : wasMyChoice
                            ? "border-red-400/40 bg-red-400/5 text-red-200"
                            : "border-white/10 text-white/60"
                        : selected
                          ? "border-spark/60 bg-spark/10 text-white"
                          : "border-white/10 text-white/70 hover:bg-white/[0.03]"
                    }`}
                  >
                    <input
                      type="radio"
                      name={q.id}
                      value={o.id}
                      checked={selected}
                      onChange={() =>
                        !result &&
                        setAnswers((a) => ({ ...a, [q.id]: o.id }))
                      }
                      className="sr-only"
                      disabled={result !== null}
                    />
                    <span className="flex-1">{o.text}</span>
                    {showResult && isCorrect && (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    )}
                    {showResult && wasMyChoice && !isCorrect && (
                      <XCircle className="h-4 w-4 text-red-400" />
                    )}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      <div className="mt-5 flex items-center gap-3">
        {result ? (
          <>
            <span
              className={`text-sm font-semibold ${
                result.score === result.total ? "text-emerald-300" : "text-spark"
              }`}
            >
              You scored {result.score}/{result.total}
            </span>
            <Button size="sm" variant="secondary" onClick={reset}>
              Try again
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={submit} disabled={pending}>
            {pending ? "Checking…" : "Submit"}
          </Button>
        )}
      </div>
    </div>
  );
}
