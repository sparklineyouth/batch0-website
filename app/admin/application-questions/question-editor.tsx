"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { QuestionListEditor } from "@/components/admin/question-list-editor";
import {
  isRequiredCore,
  type MergedQuestion,
  type ApplicationQuestionsOverrides,
} from "@/lib/application-questions";
import type { CustomQuestion } from "@/lib/question-schema";
import { saveApplicationQuestions } from "./actions";

type DraftField = {
  key: string;
  type: MergedQuestion["type"];
  label: string;
  help: string;
  placeholder: string;
  required: boolean;
  hidden: boolean;
  options: { value: number; label: string }[];
};

function toDraft(q: MergedQuestion): DraftField {
  return {
    key: q.key,
    type: q.type,
    label: q.label,
    help: q.help,
    placeholder: q.placeholder,
    required: q.required,
    hidden: q.hidden,
    options: (q.options ?? []).map((o) => ({ ...o })),
  };
}

function toOverrides(fields: DraftField[]): ApplicationQuestionsOverrides {
  const out: ApplicationQuestionsOverrides = {};
  for (const f of fields) {
    out[f.key] = {
      label: f.label,
      help: f.help,
      placeholder: f.placeholder,
      required: f.required,
      hidden: f.hidden,
      ...(f.options.length > 0
        ? {
            optionLabels: Object.fromEntries(
              f.options.map((o) => [String(o.value), o.label]),
            ),
          }
        : {}),
    };
  }
  return out;
}

/**
 * The /apply form editor: the 17 built-in fields plus the admin's own
 * questions, saved together in one action.
 *
 * One save button for both on purpose. They are one form to the applicant, and
 * a partial save — a new question added but a label edit lost — is worse than
 * a rejected one.
 */
export function QuestionEditor({
  initial,
  initialCustom,
}: {
  initial: MergedQuestion[];
  initialCustom: CustomQuestion[];
}) {
  const [fields, setFields] = useState<DraftField[]>(() => initial.map(toDraft));
  const [custom, setCustom] = useState<CustomQuestion[]>(initialCustom);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function update(index: number, patch: Partial<DraftField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    setSaved(false);
  }

  function updateOption(fieldIndex: number, value: number, label: string) {
    setFields((prev) =>
      prev.map((f, i) =>
        i === fieldIndex
          ? {
              ...f,
              options: f.options.map((o) =>
                o.value === value ? { ...o, label } : o,
              ),
            }
          : f,
      ),
    );
    setSaved(false);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    start(async () => {
      try {
        const res = await saveApplicationQuestions({
          builtins: toOverrides(fields),
          custom,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Adopt the stored list. A new question can reach the server with a
        // blank id (Safari and Firefox don't blur a label input when a
        // <button> is clicked), the server derives the permanent jsonb key,
        // and this state — not revalidatePath, which can't reset a useState —
        // is what the NEXT save sends. Left holding "" it would derive a
        // second key from a reworded label and orphan every answer already
        // filed under the first.
        if (res.data) setCustom(res.data);
        setSaved(true);
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  const removedCount = fields.filter((f) => f.hidden).length;

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-ink">Built-in questions</h2>
        <p className="mt-1 text-sm text-ink-soft">
          These seventeen are stored in their own database columns, so their
          type and what they store can't change — but you can rewrite any of
          them, and remove the ones you don't want. Removing takes a question
          off the form and stops collecting it;{" "}
          <strong className="text-ink">answers already given are kept</strong>{" "}
          and stay readable in the review queue.
          {removedCount > 0 && (
            <>
              {" "}
              <span className="text-amber-300">
                {removedCount} currently removed.
              </span>
            </>
          )}
        </p>
      </div>

      {fields.map((field, i) => {
        const core = isRequiredCore(field.key);
        return (
          <section
            key={field.key}
            className={`rounded-xl border p-4 ${
              field.hidden
                ? "border-line/60 bg-wash/40 opacity-70"
                : "border-line bg-wash"
            }`}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <code className="text-xs font-medium text-ink-soft">{field.key}</code>
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                {field.type}
                {core && " · can't be removed"}
              </span>
            </div>

            {field.hidden && (
              <p className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-300">
                Removed from the form. Past answers are untouched — turn this
                back on and it collects again.
              </p>
            )}

            <div className="space-y-4">
              <div>
                <Label htmlFor={`${field.key}-label`}>Label</Label>
                <Input
                  id={`${field.key}-label`}
                  value={field.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="Field label"
                />
              </div>

              <div>
                <Label htmlFor={`${field.key}-help`}>Help text</Label>
                <Textarea
                  id={`${field.key}-help`}
                  rows={2}
                  value={field.help}
                  onChange={(e) => update(i, { help: e.target.value })}
                  placeholder="Optional description shown under the field."
                />
              </div>

              {field.type !== "radiogroup" && (
                <div>
                  <Label htmlFor={`${field.key}-placeholder`}>Placeholder</Label>
                  <Input
                    id={`${field.key}-placeholder`}
                    value={field.placeholder}
                    onChange={(e) => update(i, { placeholder: e.target.value })}
                    placeholder="Optional placeholder text."
                  />
                </div>
              )}

              {field.options.length > 0 && (
                <div>
                  <Label>Option labels</Label>
                  <p className="mb-2 text-xs text-ink-faint">
                    You can rename each choice, but not add, remove, or change
                    what it stores.
                  </p>
                  <div className="space-y-2">
                    {field.options.map((opt) => (
                      <div key={opt.value} className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-center text-xs text-ink-faint">
                          {opt.value}
                        </span>
                        <Input
                          aria-label={`Label for option ${opt.value}`}
                          value={opt.label}
                          onChange={(e) => updateOption(i, opt.value, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Required"
                  description={
                    core
                      ? "This field is always required."
                      : field.hidden
                        ? "Not collected while removed."
                        : "Applicants must fill this in."
                  }
                  checked={field.required}
                  disabled={core || field.hidden}
                  onChange={(v) => update(i, { required: v })}
                />
                <Toggle
                  label="Remove from form"
                  description={
                    core
                      ? "The application can't work without this one."
                      : "Stops collecting it. Existing answers are kept."
                  }
                  checked={field.hidden}
                  disabled={core}
                  onChange={(v) =>
                    update(i, { hidden: v, required: v ? false : field.required })
                  }
                />
              </div>
            </div>
          </section>
        );
      })}

      <div className="border-t border-line pt-8">
        <h2 className="text-lg font-semibold text-ink">Your questions</h2>
        <p className="mb-4 mt-1 text-sm text-ink-soft">
          Anything else you want to ask. These are yours to add, reorder and
          delete — their answers are stored alongside the application rather
          than in a column of their own. They appear in a section of their own
          at the end of the form, in the order below.
        </p>
        <QuestionListEditor
          questions={custom}
          onChange={(next) => {
            setCustom(next);
            setSaved(false);
          }}
          reservedIds={fields.map((f) => f.key)}
          emptyHint="No extra questions yet. Add one and it shows up at the end of the application."
          disabled={pending}
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save the application form"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </form>
  );
}
