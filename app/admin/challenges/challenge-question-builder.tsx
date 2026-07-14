"use client";
import { ChevronUp, ChevronDown, Trash2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import {
  CHALLENGE_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  newQuestionId,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  type ChallengeQuestionType,
} from "@/lib/challenges-shared";

export type DraftQuestion = {
  id: string;
  type: ChallengeQuestionType;
  label: string;
  help: string;
  placeholder: string;
  required: boolean;
  options: string[];
};

export function blankQuestion(): DraftQuestion {
  return {
    id: newQuestionId(),
    type: "short_text",
    label: "",
    help: "",
    placeholder: "",
    required: false,
    options: [],
  };
}

export function ChallengeQuestionBuilder({
  value,
  onChange,
}: {
  value: DraftQuestion[];
  onChange: (next: DraftQuestion[]) => void;
}) {
  function update(i: number, patch: Partial<DraftQuestion>) {
    onChange(value.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    if (value.length >= MAX_QUESTIONS) return;
    onChange([...value, blankQuestion()]);
  }
  function setType(i: number, type: ChallengeQuestionType) {
    // Seed two starter options when switching to multiple choice.
    const patch: Partial<DraftQuestion> = { type };
    if (type === "select" && value[i].options.length < 2) {
      patch.options = ["", ""];
    }
    update(i, patch);
  }
  function updateOption(qi: number, oi: number, text: string) {
    update(qi, {
      options: value[qi].options.map((o, idx) => (idx === oi ? text : o)),
    });
  }
  function addOption(qi: number) {
    if (value[qi].options.length >= MAX_OPTIONS) return;
    update(qi, { options: [...value[qi].options, ""] });
  }
  function removeOption(qi: number, oi: number) {
    update(qi, { options: value[qi].options.filter((_, idx) => idx !== oi) });
  }

  return (
    <div className="space-y-4">
      {value.length === 0 && (
        <p className="rounded-xl border border-dashed border-line bg-wash px-4 py-6 text-center text-sm text-ink-faint">
          No questions yet. Add the first one below — applicants answer these on
          a single page.
        </p>
      )}

      {value.map((q, i) => (
        <section
          key={q.id}
          className="rounded-xl border border-line bg-wash p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Question {i + 1}
            </span>
            <div className="flex items-center gap-1">
              <IconBtn
                label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ChevronUp className="h-4 w-4" />
              </IconBtn>
              <IconBtn
                label="Move down"
                disabled={i === value.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronDown className="h-4 w-4" />
              </IconBtn>
              <IconBtn label="Remove question" onClick={() => remove(i)} danger>
                <Trash2 className="h-4 w-4" />
              </IconBtn>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <div>
                <Label htmlFor={`${q.id}-label`}>Question</Label>
                <Input
                  id={`${q.id}-label`}
                  value={q.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="e.g. What will you build?"
                />
              </div>
              <div>
                <Label htmlFor={`${q.id}-type`}>Type</Label>
                <Select
                  id={`${q.id}-type`}
                  value={q.type}
                  onChange={(e) =>
                    setType(i, e.target.value as ChallengeQuestionType)
                  }
                >
                  {CHALLENGE_QUESTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {QUESTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor={`${q.id}-help`}>Help text</Label>
              <Textarea
                id={`${q.id}-help`}
                rows={2}
                value={q.help}
                onChange={(e) => update(i, { help: e.target.value })}
                placeholder="Optional guidance shown under the question."
              />
            </div>

            {q.type !== "select" && (
              <div>
                <Label htmlFor={`${q.id}-placeholder`}>Placeholder</Label>
                <Input
                  id={`${q.id}-placeholder`}
                  value={q.placeholder}
                  onChange={(e) => update(i, { placeholder: e.target.value })}
                  placeholder={
                    q.type === "url" ? "https://…" : "Optional placeholder text."
                  }
                />
              </div>
            )}

            {q.type === "select" && (
              <div>
                <Label>Choices</Label>
                <p className="mb-2 text-xs text-ink-faint">
                  At least two. Applicants pick exactly one.
                </p>
                <div className="space-y-2">
                  {q.options.map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <Input
                        aria-label={`Choice ${oi + 1}`}
                        value={opt}
                        onChange={(e) => updateOption(i, oi, e.target.value)}
                        placeholder={`Choice ${oi + 1}`}
                      />
                      <IconBtn
                        label={`Remove choice ${oi + 1}`}
                        disabled={q.options.length <= 2}
                        onClick={() => removeOption(i, oi)}
                        danger
                      >
                        <X className="h-4 w-4" />
                      </IconBtn>
                    </div>
                  ))}
                </div>
                {q.options.length < MAX_OPTIONS && (
                  <button
                    type="button"
                    onClick={() => addOption(i)}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-phosphor-ink hover:underline"
                  >
                    <Plus className="h-3 w-3" /> Add choice
                  </button>
                )}
              </div>
            )}

            <Toggle
              label="Required"
              description="Applicants must answer this to submit."
              checked={q.required}
              onChange={(v) => update(i, { required: v })}
            />
          </div>
        </section>
      ))}

      {value.length < MAX_QUESTIONS ? (
        <Button type="button" variant="secondary" onClick={add}>
          <Plus className="h-4 w-4" /> Add question
        </Button>
      ) : (
        <p className="text-xs text-ink-faint">
          Maximum of {MAX_QUESTIONS} questions reached.
        </p>
      )}
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-ink-soft transition hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "hover:border-red-400/50 hover:text-red-400" : ""
      }`}
    >
      {children}
    </button>
  );
}
