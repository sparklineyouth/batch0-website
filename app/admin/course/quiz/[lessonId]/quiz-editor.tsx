"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { saveQuiz, deleteQuiz, type QuizQuestionInput } from "./actions";

function makeId() {
  return Math.random().toString(36).slice(2, 8);
}

function emptyQuestion(): QuizQuestionInput {
  const opts = [
    { id: makeId(), text: "" },
    { id: makeId(), text: "" },
  ];
  return {
    question: "",
    options: opts,
    correct_option_id: opts[0].id,
    position: 0,
  };
}

export function QuizEditor({
  lessonId,
  initialTitle,
  initialQuestions,
}: {
  lessonId: string;
  initialTitle: string;
  initialQuestions: QuizQuestionInput[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [questions, setQuestions] = useState<QuizQuestionInput[]>(
    initialQuestions.length > 0 ? initialQuestions : [emptyQuestion()],
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  function update(i: number, patch: Partial<QuizQuestionInput>) {
    setQuestions((prev) =>
      prev.map((q, idx) => (idx === i ? { ...q, ...patch } : q)),
    );
  }

  function addQuestion() {
    setQuestions((prev) => [
      ...prev,
      { ...emptyQuestion(), position: prev.length },
    ]);
  }

  function removeQuestion(i: number) {
    setQuestions((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addOption(qi: number) {
    setQuestions((prev) =>
      prev.map((q, idx) =>
        idx === qi
          ? { ...q, options: [...q.options, { id: makeId(), text: "" }] }
          : q,
      ),
    );
  }

  function removeOption(qi: number, oi: number) {
    setQuestions((prev) =>
      prev.map((q, idx) => {
        if (idx !== qi) return q;
        const opts = q.options.filter((_, j) => j !== oi);
        const correct = opts.some((o) => o.id === q.correct_option_id)
          ? q.correct_option_id
          : opts[0]?.id;
        return { ...q, options: opts, correct_option_id: correct ?? "" };
      }),
    );
  }

  function setOptionText(qi: number, oi: number, text: string) {
    setQuestions((prev) =>
      prev.map((q, idx) => {
        if (idx !== qi) return q;
        const opts = q.options.map((o, j) =>
          j === oi ? { ...o, text } : o,
        );
        return { ...q, options: opts };
      }),
    );
  }

  function save() {
    setError(undefined);
    setSaved(false);
    start(async () => {
      try {
        await saveQuiz({ lessonId, title, questions });
        setSaved(true);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function deleteAll() {
    setError(undefined);
    start(async () => {
      try {
        await deleteQuiz(lessonId);
        setQuestions([emptyQuestion()]);
        setTitle("");
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <Label>Quiz title (optional)</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Check your understanding"
        />
      </div>

      <ol className="space-y-4">
        {questions.map((q, qi) => (
          <li
            key={qi}
            className="rounded-xl border border-white/10 bg-black/30 p-4"
          >
            <div className="flex items-start gap-2">
              <div className="mt-2 text-white/30">
                <GripVertical className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <Label>Question {qi + 1}</Label>
                <Input
                  value={q.question}
                  onChange={(e) => update(qi, { question: e.target.value })}
                  placeholder="What is…?"
                />
                <div className="mt-3 space-y-2">
                  {q.options.map((o, oi) => (
                    <div key={o.id} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`correct-${qi}`}
                        checked={q.correct_option_id === o.id}
                        onChange={() =>
                          update(qi, { correct_option_id: o.id })
                        }
                        aria-label="Mark correct"
                        className="h-4 w-4 accent-[#facc15]"
                      />
                      <Input
                        value={o.text}
                        onChange={(e) => setOptionText(qi, oi, e.target.value)}
                        placeholder={`Option ${oi + 1}`}
                      />
                      {q.options.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeOption(qi, oi)}
                          aria-label="Remove option"
                          className="text-white/40 hover:text-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() => addOption(qi)}
                    className="text-spark hover:underline"
                  >
                    + Add option
                  </button>
                  <button
                    type="button"
                    onClick={() => removeQuestion(qi)}
                    className="text-white/40 hover:text-red-400"
                  >
                    Remove question
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={addQuestion}>
          <Plus className="h-3.5 w-3.5" /> Add question
        </Button>
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save quiz"}
        </Button>
        {initialQuestions.length > 0 && (
          <Button variant="ghost" onClick={deleteAll} disabled={pending}>
            Delete quiz
          </Button>
        )}
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}
