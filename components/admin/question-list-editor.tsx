"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Label } from "@/components/ui/input";
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  hasOptions,
  uniqueQuestionId,
  blankQuestion,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type CustomQuestion,
  type QuestionType,
} from "@/lib/question-schema";

// ---------------------------------------------------------------------------
// The editor for a list of admin-authored questions.
//
// Used in three places — the extra questions on /apply, the shared scholarship
// block on /apply, and each scholarship's own questions — because all three
// are the same thing: an ordered list of CustomQuestion answered into a jsonb
// blob. One component means one notion of what "required" looks like and one
// place to fix a rendering bug.
//
// It is a controlled component: the parent owns the array and the save button.
// That's what lets the /apply page save built-ins and custom questions in a
// single atomic action rather than two that can half-succeed.
// ---------------------------------------------------------------------------

export function QuestionListEditor({
  questions,
  onChange,
  /** Ids that already exist elsewhere on the same form — kept unique against them. */
  reservedIds = [],
  emptyHint = "No extra questions yet.",
}: {
  questions: CustomQuestion[];
  onChange: (next: CustomQuestion[]) => void;
  reservedIds?: string[];
  emptyHint?: string;
}) {
  function patch(index: number, next: Partial<CustomQuestion>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...next } : q)));
  }

  /**
   * Derive the jsonb key from the label, but ONLY while the question is new.
   *
   * Once an id exists it is frozen: it is the key every answer already
   * collected is filed under, so renaming the label of a live question must
   * not orphan its answers. This is the single most consequential rule in the
   * editor and the reason the id is shown on screen rather than hidden.
   */
  function setLabel(index: number, label: string) {
    const q = questions[index];
    if (q.id) {
      patch(index, { label });
      return;
    }
    const taken = [
      ...reservedIds,
      ...questions.filter((_, i) => i !== index).map((x) => x.id),
    ].filter(Boolean);
    patch(index, { label, id: uniqueQuestionId(label, taken) });
  }

  function setType(index: number, type: QuestionType) {
    const nowHasOptions = hasOptions(type);
    onChange(
      questions.map((x, i) =>
        i === index
          ? {
              ...x,
              type,
              // Switching INTO a choice type seeds two blank options so the
              // validator's "needs at least two" doesn't fire on a question
              // the admin has only just started. Switching OUT clears them,
              // because options on a text field are a validation error.
              options: nowHasOptions
                ? x.options.length >= 2
                  ? x.options
                  : blankQuestion(type).options
                : [],
            }
          : x,
      ),
    );
  }

  /**
   * Rename an option. The stored VALUE is deliberately untouched — it is what
   * every answer already collected holds, so a label edit must never rewrite
   * it. That's also why the value is shown beside the input rather than hidden.
   */
  function setOption(index: number, optIndex: number, label: string) {
    const q = questions[index];
    patch(index, {
      options: q.options.map((o, i) => (i === optIndex ? { ...o, label } : o)),
    });
  }

  function addOption(index: number) {
    const q = questions[index];
    if (q.options.length >= MAX_OPTIONS) return;
    const used = new Set(q.options.map((o) => o.value));
    let n = q.options.length + 1;
    while (used.has(`option_${n}`)) n += 1;
    patch(index, { options: [...q.options, { value: `option_${n}`, label: "" }] });
  }

  function removeOption(index: number, optIndex: number) {
    const q = questions[index];
    patch(index, { options: q.options.filter((_, i) => i !== optIndex) });
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function addQuestion() {
    if (questions.length >= MAX_QUESTIONS) return;
    onChange([...questions, blankQuestion("text")]);
  }

  function deleteQuestion(index: number) {
    onChange(questions.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-4">
      {questions.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-soft">
          {emptyHint}
        </p>
      )}

      {questions.map((q, i) => (
        <section
          key={`${q.id || "new"}-${i}`}
          className="rounded-xl border border-line bg-wash p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <code className="text-xs font-medium text-ink-soft">
              {q.id || <span className="italic">id set from the label</span>}
            </code>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Move down"
                disabled={i === questions.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch(i, { hidden: !q.hidden, required: false })}
              >
                {q.hidden ? "Show" : "Hide"}
              </Button>
              <Button size="sm" variant="danger" onClick={() => deleteQuestion(i)}>
                Delete
              </Button>
            </div>
          </div>

          {q.hidden && (
            <p className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-300">
              Hidden — not shown on the form. Answers already collected are kept.
            </p>
          )}

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[2fr,1fr]">
              <div>
                <Label htmlFor={`q-${i}-label`}>Question</Label>
                <Input
                  id={`q-${i}-label`}
                  value={q.label}
                  onChange={(e) => setLabel(i, e.target.value)}
                  placeholder="What's the biggest risk to your project?"
                />
              </div>
              <div>
                <Label htmlFor={`q-${i}-type`}>Answer type</Label>
                <Select
                  id={`q-${i}-type`}
                  value={q.type}
                  onChange={(e) => setType(i, e.target.value as QuestionType)}
                >
                  {QUESTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {QUESTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor={`q-${i}-help`}>Help text</Label>
              <Textarea
                id={`q-${i}-help`}
                rows={2}
                value={q.help}
                onChange={(e) => patch(i, { help: e.target.value })}
                placeholder="Optional. Shown under the question."
              />
            </div>

            {!hasOptions(q.type) && q.type !== "checkbox" && (
              <div>
                <Label htmlFor={`q-${i}-ph`}>Placeholder</Label>
                <Input
                  id={`q-${i}-ph`}
                  value={q.placeholder}
                  onChange={(e) => patch(i, { placeholder: e.target.value })}
                  placeholder="Optional."
                />
              </div>
            )}

            {hasOptions(q.type) && (
              <div>
                <Label>Options</Label>
                <div className="space-y-2">
                  {q.options.map((opt, oi) => (
                    <div key={opt.value} className="flex items-center gap-2">
                      <code className="w-20 shrink-0 truncate text-[11px] text-ink-faint">
                        {opt.value}
                      </code>
                      <Input
                        aria-label={`Option ${oi + 1} label`}
                        value={opt.label}
                        onChange={(e) => setOption(i, oi, e.target.value)}
                        placeholder={`Option ${oi + 1}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove option ${oi + 1}`}
                        disabled={q.options.length <= 2}
                        onClick={() => removeOption(i, oi)}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  disabled={q.options.length >= MAX_OPTIONS}
                  onClick={() => addOption(i)}
                >
                  + Add option
                </Button>
                <p className="mt-2 text-xs text-ink-faint">
                  The code on the left is what gets stored. It stays put when you
                  rename an option, so existing answers keep their meaning.
                </p>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={q.required}
                disabled={q.hidden}
                onChange={(e) => patch(i, { required: e.target.checked })}
                className="h-4 w-4 rounded border-line"
              />
              Required
            </label>
          </div>
        </section>
      ))}

      <Button
        variant="secondary"
        size="sm"
        disabled={questions.length >= MAX_QUESTIONS}
        onClick={addQuestion}
      >
        + Add question
      </Button>
      {questions.length >= MAX_QUESTIONS && (
        <p className="text-xs text-ink-faint">
          That's the maximum of {MAX_QUESTIONS} questions.
        </p>
      )}
    </div>
  );
}
