"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select, Label } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { QuestionListEditor } from "@/components/admin/question-list-editor";
import type { CustomQuestion } from "@/lib/question-schema";
import {
  saveScholarshipInterestQuestions,
  saveScholarshipQuestions,
} from "./actions";

export type ScholarshipChoice = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  awardSummary: string;
  enabled: boolean;
  questions: CustomQuestion[];
};

// The shared block is a scholarship-shaped pseudo-entry in the same dropdown,
// so the admin picks "which scholarship am I editing" in one control rather
// than hunting for a separate panel above it.
const SHARED = "__shared__";

/**
 * Scholarship questions — the second section of /admin/application-questions.
 *
 * Two different things live behind one dropdown, and the distinction is worth
 * stating on screen because it decides who ever sees the question:
 *
 *   THE SHARED BLOCK runs on /apply, for everyone, before anyone is accepted.
 *   It can only usefully flag interest ("would financial help change whether
 *   you can do this?") — there is no specific scholarship to ask about yet.
 *
 *   A SCHOLARSHIP'S OWN QUESTIONS run on that scholarship's application, which
 *   a student reaches only after being accepted. This is where the real merit
 *   questions go, and they can differ completely between scholarships.
 *
 * Each target saves on its own, because they are genuinely separate records
 * (one site_settings row; one `scholarships` row each) and saving all of them
 * on one button would write rows the admin never looked at.
 */
export function ScholarshipQuestionsEditor({
  initialShared,
  scholarships,
}: {
  initialShared: CustomQuestion[];
  scholarships: ScholarshipChoice[];
}) {
  const [target, setTarget] = useState<string>(SHARED);
  const [shared, setShared] = useState<CustomQuestion[]>(initialShared);
  const [perScholarship, setPerScholarship] = useState<
    Record<string, CustomQuestion[]>
  >(() => Object.fromEntries(scholarships.map((s) => [s.id, s.questions])));

  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isShared = target === SHARED;
  const current = scholarships.find((s) => s.id === target) ?? null;
  const questions = isShared ? shared : (perScholarship[target] ?? []);

  function onChange(next: CustomQuestion[]) {
    setSaved(false);
    if (isShared) setShared(next);
    else setPerScholarship((prev) => ({ ...prev, [target]: next }));
  }

  function onSave() {
    setError(undefined);
    start(async () => {
      try {
        const res = isShared
          ? await saveScholarshipInterestQuestions(shared)
          : await saveScholarshipQuestions(target, perScholarship[target] ?? []);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Adopt the stored list, so this state holds exactly the ids the
        // database does. A question saved with a blank id got its permanent
        // jsonb key derived on the server; keeping "" here would send it again
        // next save and re-derive a different key from a reworded label,
        // orphaning the answers already collected under the first one.
        const stored = res.data;
        if (stored) {
          if (isShared) setShared(stored);
          else setPerScholarship((prev) => ({ ...prev, [target]: stored }));
        }
        setSaved(true);
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="max-w-md">
        <Label htmlFor="scholarship-target">Editing questions for</Label>
        <Select
          id="scholarship-target"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setSaved(false);
            setError(undefined);
          }}
        >
          <option value={SHARED}>
            Everyone on /apply — shared scholarship block
          </option>
          {scholarships.length > 0 && (
            <optgroup label="One scholarship's own questions">
              {scholarships.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.awardSummary}
                  {s.enabled ? "" : " (disabled)"}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>

      {isShared ? (
        <p className="rounded-lg border border-line bg-wash px-3 py-2 text-xs text-ink-soft">
          Shown to <strong className="text-ink">every applicant</strong> on
          /apply, in a scholarship section after the main questions. Nobody has
          been accepted at this point, so keep these to flagging interest — the
          questions that decide an award belong on a specific scholarship below.
        </p>
      ) : current ? (
        <p className="rounded-lg border border-line bg-wash px-3 py-2 text-xs text-ink-soft">
          Shown only to students applying for{" "}
          <strong className="text-ink">{current.name}</strong>, after they've
          been accepted. This is where merit questions go.{" "}
          <a
            className="underline hover:no-underline"
            href={`/admin/scholarships/${current.id}`}
          >
            Edit the scholarship itself →
          </a>
        </p>
      ) : null}

      {scholarships.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-xs text-ink-soft">
          No scholarships exist yet.{" "}
          <a className="underline hover:no-underline" href="/admin/scholarships">
            Create one
          </a>{" "}
          and its own questions become editable here.
        </p>
      )}

      <QuestionListEditor
        key={target}
        questions={questions}
        onChange={onChange}
        emptyHint={
          isShared
            ? "No shared scholarship questions. Add one and it appears for every applicant."
            : "No extra questions on this scholarship yet."
        }
        disabled={pending}
      />

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={pending}>
          {pending
            ? "Saving…"
            : isShared
              ? "Save the shared block"
              : `Save ${current?.name ?? "scholarship"} questions`}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </div>
  );
}
