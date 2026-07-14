"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { HTTP_URL_RE, type Challenge } from "@/lib/challenges-shared";
import { submitChallengeApplication } from "./actions";

export function ChallengeForm({
  challenge,
  refCode,
}: {
  challenge: Pick<Challenge, "id" | "slug" | "title" | "questions">;
  refCode?: string | null;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const [pending, start] = useTransition();

  function set(id: string, value: string) {
    setAnswers((a) => ({ ...a, [id]: value }));
    setFieldErrors((e) => (e[id] ? { ...e, [id]: "" } : e));
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    for (const q of challenge.questions) {
      const v = (answers[q.id] ?? "").trim();
      if (q.required && !v) {
        errs[q.id] = "Required";
        continue;
      }
      if (q.type === "url" && v && !HTTP_URL_RE.test(v)) {
        errs[q.id] = "Must be a full URL starting with http:// or https://";
      }
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    if (!validate()) return;
    start(async () => {
      const fd = new FormData();
      fd.set("slug", challenge.slug);
      if (refCode) fd.set("referral_code", refCode);
      for (const q of challenge.questions) {
        fd.set(`q_${q.id}`, answers[q.id] ?? "");
      }
      const res = await submitChallengeApplication(null, fd);
      if (res.ok) {
        setSubmitted(true);
        return;
      }
      if (res.fieldErrors) setFieldErrors(res.fieldErrors);
      setFormError(res.error);
    });
  }

  if (submitted) {
    return (
      <div className="rounded-2xl border border-phosphor/30 bg-phosphor/5 p-6">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-phosphor-ink">
          Application in
        </p>
        <h2 className="mt-2 font-display text-2xl font-bold tracking-[-0.02em] text-ink">
          You&apos;re entered.
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          We review funding decisions weekly and will email you either way.
          Thanks for building with us.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/dashboard">
            <Button variant="secondary">Go to dashboard</Button>
          </Link>
          <Link href="/challenges">
            <Button variant="ghost">See other challenges</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-line bg-wash p-5 sm:p-6 md:p-8"
    >
      <div className="space-y-6">
        {challenge.questions.map((q) => {
          const err = fieldErrors[q.id] || undefined;
          const inputId = `q_${q.id}`;
          return (
            <div key={q.id}>
              <Label htmlFor={inputId} required={q.required}>
                {q.label}
                {q.required && <span aria-hidden className="text-phosphor-ink"> *</span>}
              </Label>
              {q.help && (
                <p className="mb-1.5 text-xs text-ink-soft">{q.help}</p>
              )}

              {q.type === "long_text" ? (
                <Textarea
                  id={inputId}
                  rows={5}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  placeholder={q.placeholder}
                  error={err}
                />
              ) : q.type === "select" ? (
                <div
                  role="radiogroup"
                  aria-label={q.label}
                  className="flex flex-wrap gap-2"
                >
                  {q.options.map((opt) => {
                    const active = (answers[q.id] ?? "") === opt;
                    return (
                      <label
                        key={opt}
                        className={`press inline-flex cursor-pointer items-center rounded-md border px-3.5 py-2 text-sm transition ${
                          active
                            ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
                            : "border-line text-ink-soft hover:border-ink/30"
                        }`}
                      >
                        <input
                          type="radio"
                          name={inputId}
                          value={opt}
                          checked={active}
                          onChange={() => set(q.id, opt)}
                          className="sr-only"
                        />
                        {opt}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <Input
                  id={inputId}
                  type={q.type === "url" ? "url" : "text"}
                  inputMode={q.type === "url" ? "url" : undefined}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  placeholder={q.placeholder}
                  error={err}
                />
              )}

              <FieldError id={`${inputId}-error`}>{err}</FieldError>
            </div>
          );
        })}

        {challenge.questions.length === 0 && (
          <p className="text-sm text-ink-soft">
            This challenge doesn&apos;t have any questions yet — check back
            shortly.
          </p>
        )}
      </div>

      {formError && (
        <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {formError}
        </p>
      )}

      <div className="mt-8">
        <Button type="submit" size="lg" disabled={pending || challenge.questions.length === 0}>
          {pending ? "Submitting…" : "Submit application"}
        </Button>
        <p className="mt-3 text-xs text-ink-faint">
          Free to apply. We review weekly and fund the ones we love.
        </p>
      </div>
    </form>
  );
}
