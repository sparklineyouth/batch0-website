"use client";
import * as React from "react";
import { Input, Textarea, Select, Label, FieldError } from "@/components/ui/input";
import {
  fieldName,
  hasOptions,
  type CustomQuestion,
} from "@/lib/question-schema";

// ---------------------------------------------------------------------------
// Renders admin-authored questions on a public form.
//
// Shared by /apply (the extra questions and the scholarship-interest block)
// and by each scholarship's own application, because all three render the same
// CustomQuestion shape. One renderer means one place where "required" gets its
// asterisk and one place where a checkbox's label association can be wrong.
//
// The answer state is a flat Record<string, string> keyed by the POSTED field
// name (prefix__id), not by the bare question id. That's deliberate: it is
// exactly what goes into FormData, so there is no second mapping step between
// what the user typed and what the server validates — and no opportunity for
// the two to disagree about which question an answer belongs to.
//
// A checkbox stores "on" / "" rather than a boolean for the same reason: "on"
// is what a real checkbox input posts, and lib/question-schema.ts readAnswers
// already knows how to turn it back into a boolean on the server.
// ---------------------------------------------------------------------------

export type AnswerState = Record<string, string>;

/** Seed the state from answers already saved (a draft, or an edit). */
export function seedAnswers(
  questions: readonly CustomQuestion[],
  prefix: string,
  saved: Readonly<Record<string, unknown>> | null | undefined,
): AnswerState {
  const out: AnswerState = {};
  for (const q of questions) {
    const value = saved?.[q.id];
    const name = fieldName(prefix, q.id);
    if (q.type === "checkbox") {
      out[name] = value === true ? "on" : "";
    } else {
      out[name] = value === null || value === undefined ? "" : String(value);
    }
  }
  return out;
}

export function CustomQuestionFields({
  questions,
  prefix,
  values,
  onChange,
  errors = {},
  fieldClassName = "",
}: {
  questions: readonly CustomQuestion[];
  prefix: string;
  values: AnswerState;
  onChange: (name: string, value: string) => void;
  /** Keyed by POSTED field name, matching what the server action returns. */
  errors?: Record<string, string>;
  fieldClassName?: string;
}) {
  return (
    <>
      {questions
        .filter((q) => !q.hidden)
        .map((q) => {
          const name = fieldName(prefix, q.id);
          const value = values[name] ?? "";
          const error = errors[name];
          const errorId = `${name}-error`;
          const helpId = q.help ? `${name}-help` : undefined;

          // A checkbox carries its own label to the right of the box, so it
          // doesn't get the standard <Label> above — doubling them up reads
          // to a screen reader as the question being announced twice.
          if (q.type === "checkbox") {
            return (
              <div key={name}>
                <label className="flex items-start gap-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    name={name}
                    checked={value === "on"}
                    aria-describedby={
                      [helpId, error ? errorId : null].filter(Boolean).join(" ") ||
                      undefined
                    }
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => onChange(name, e.target.checked ? "on" : "")}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-line"
                  />
                  <span>
                    {q.label}
                    {q.required && (
                      <>
                        <span aria-hidden className="text-phosphor-ink">
                          {" "}
                          *
                        </span>
                        <span className="sr-only"> required</span>
                      </>
                    )}
                  </span>
                </label>
                {q.help && (
                  <p id={helpId} className="mt-1 text-xs text-ink-soft">
                    {q.help}
                  </p>
                )}
                <FieldError id={errorId}>{error}</FieldError>
              </div>
            );
          }

          const described =
            [helpId, error ? errorId : null].filter(Boolean).join(" ") || undefined;

          return (
            <div key={name}>
              <Label htmlFor={name} required={q.required}>
                {q.label}
                {q.required && (
                  <span aria-hidden className="text-phosphor-ink">
                    {" "}
                    *
                  </span>
                )}
              </Label>

              {q.help && (
                <p id={helpId} className="mb-1.5 text-xs text-ink-soft">
                  {q.help}
                </p>
              )}

              {q.type === "textarea" ? (
                <Textarea
                  id={name}
                  name={name}
                  rows={4}
                  value={value}
                  error={!!error}
                  aria-describedby={described}
                  placeholder={q.placeholder || undefined}
                  onChange={(e) => onChange(name, e.target.value)}
                  className={fieldClassName}
                />
              ) : hasOptions(q.type) ? (
                q.type === "select" ? (
                  <Select
                    id={name}
                    name={name}
                    value={value}
                    error={!!error}
                    aria-describedby={described}
                    onChange={(e) => onChange(name, e.target.value)}
                    className={fieldClassName}
                  >
                    <option value="">Choose…</option>
                    {q.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div
                    role="radiogroup"
                    aria-label={q.label}
                    aria-describedby={described}
                    className="flex flex-wrap gap-2"
                  >
                    {q.options.map((o) => {
                      const selected = value === o.value;
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => onChange(name, o.value)}
                          className={`rounded-lg border px-3 py-2 text-sm transition active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor/60 ${
                            selected
                              ? "border-phosphor bg-phosphor/15 text-ink"
                              : "border-line bg-paper text-ink-soft hover:border-ink/30 hover:text-ink"
                          }`}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                )
              ) : (
                <Input
                  id={name}
                  name={name}
                  type={
                    q.type === "number"
                      ? "number"
                      : q.type === "email"
                        ? "email"
                        : q.type === "date"
                          ? "date"
                          : q.type === "url"
                            ? "url"
                            : "text"
                  }
                  value={value}
                  error={!!error}
                  aria-describedby={described}
                  placeholder={q.placeholder || undefined}
                  onChange={(e) => onChange(name, e.target.value)}
                  className={fieldClassName}
                />
              )}

              <FieldError id={errorId}>{error}</FieldError>
            </div>
          );
        })}
    </>
  );
}
