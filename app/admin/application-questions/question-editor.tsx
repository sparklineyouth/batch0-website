"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import {
  isRequiredCore,
  type MergedQuestion,
  type ApplicationQuestionsOverrides,
} from "@/lib/application-questions";
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

function toOverrides(
  fields: DraftField[],
): ApplicationQuestionsOverrides {
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

export function QuestionEditor({ initial }: { initial: MergedQuestion[] }) {
  const [fields, setFields] = useState<DraftField[]>(() =>
    initial.map(toDraft),
  );
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function update(index: number, patch: Partial<DraftField>) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );
    setSaved(false);
  }

  function updateOption(
    fieldIndex: number,
    value: number,
    label: string,
  ) {
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
        const res = await saveApplicationQuestions(toOverrides(fields));
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
    <form onSubmit={onSubmit} className="space-y-6">
      {fields.map((field, i) => {
        const core = isRequiredCore(field.key);
        return (
          <section
            key={field.key}
            className="rounded-xl border border-white/10 bg-black/20 p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <code className="text-xs font-medium text-white/45">
                {field.key}
              </code>
              <span className="text-[11px] uppercase tracking-wider text-white/40">
                {field.type}
                {core && " · required core"}
              </span>
            </div>

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
                  <Label htmlFor={`${field.key}-placeholder`}>
                    Placeholder
                  </Label>
                  <Input
                    id={`${field.key}-placeholder`}
                    value={field.placeholder}
                    onChange={(e) =>
                      update(i, { placeholder: e.target.value })
                    }
                    placeholder="Optional placeholder text."
                  />
                </div>
              )}

              {field.options.length > 0 && (
                <div>
                  <Label>Option labels</Label>
                  <p className="mb-2 text-xs text-white/40">
                    You can rename each choice, but not add, remove, or change
                    what it stores.
                  </p>
                  <div className="space-y-2">
                    {field.options.map((opt) => (
                      <div
                        key={opt.value}
                        className="flex items-center gap-2"
                      >
                        <span className="w-8 shrink-0 text-center text-xs text-white/40">
                          {opt.value}
                        </span>
                        <Input
                          aria-label={`Label for option ${opt.value}`}
                          value={opt.label}
                          onChange={(e) =>
                            updateOption(i, opt.value, e.target.value)
                          }
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
                      : "Applicants must fill this in."
                  }
                  checked={field.required}
                  disabled={core}
                  onChange={(v) => update(i, { required: v })}
                />
                <Toggle
                  label="Hidden"
                  description={
                    core
                      ? "This field can't be hidden."
                      : "Remove this field from the form."
                  }
                  checked={field.hidden}
                  disabled={core}
                  onChange={(v) => update(i, { hidden: v })}
                />
              </div>
            </div>
          </section>
        );
      })}

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save questions"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </form>
  );
}
