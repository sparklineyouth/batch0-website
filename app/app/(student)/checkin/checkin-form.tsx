"use client";
import { useState, useTransition } from "react";
import { Check, Trophy } from "lucide-react";
import { submitCheckin } from "@/app/dashboard/checkin/actions";
import { getActionError } from "@/lib/action-error";

/**
 * The weekly check-in, phone-sized.
 *
 * It calls the same `submitCheckin` server action as /dashboard/checkin — not a
 * mobile copy of it. That action carries the enrollment check, the pre-cohort
 * gate, the 4000-character cap, the #wins cross-post and the staff fan-out; a
 * parallel implementation would drift from all six, and the failure would be
 * silent (check-ins that never notify a mentor read exactly like check-ins
 * nobody replied to).
 *
 * The upsert is on (user_id, week_start), so re-submitting edits this week's
 * entry rather than creating a second one. That's why the form is prefilled and
 * the button says "Update" once something exists — the alternative is a student
 * assuming they've double-posted.
 */
export function CheckinForm({
  initial,
  weekLabel,
}: {
  initial: {
    accomplished: string;
    next_up: string;
    blockers: string;
    is_milestone: boolean;
  } | null;
  weekLabel: string;
}) {
  const [accomplished, setAccomplished] = useState(initial?.accomplished ?? "");
  const [nextUp, setNextUp] = useState(initial?.next_up ?? "");
  const [blockers, setBlockers] = useState(initial?.blockers ?? "");
  const [milestone, setMilestone] = useState(initial?.is_milestone ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // Mirrors the server's own rule rather than inventing a stricter one: the
  // action rejects a check-in where all three sections are blank.
  const empty = !accomplished.trim() && !nextUp.trim() && !blockers.trim();

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await submitCheckin({
          accomplished,
          next_up: nextUp,
          blockers,
          is_milestone: milestone,
        });
        setSaved(true);
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      <Field
        label="What you shipped"
        hint="Concrete things. “Talked to 6 users”, not “made progress”."
        value={accomplished}
        onChange={setAccomplished}
        placeholder="Shipped the landing page, ran 6 customer interviews…"
      />
      <Field
        label="What's next"
        hint="The single most important thing for the coming week."
        value={nextUp}
        onChange={setNextUp}
        placeholder="Get 10 signups from the waitlist…"
      />
      <Field
        label="What's blocking you"
        hint="This is the part mentors actually read. Say the real thing."
        value={blockers}
        onChange={setBlockers}
        placeholder="Can't decide between two pricing models…"
      />

      <button
        type="button"
        onClick={() => setMilestone((m) => !m)}
        aria-pressed={milestone}
        className={`press flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left active:scale-[0.99] ${
          milestone
            ? "border-phosphor/40 bg-phosphor/[0.08]"
            : "border-line bg-wash"
        }`}
      >
        <Trophy
          className={`h-4 w-4 shrink-0 ${
            milestone ? "text-phosphor-ink" : "text-ink-faint"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-tight text-ink">
            This was a milestone
          </span>
          <span className="mt-1 block text-[12px] leading-snug text-ink-soft">
            Cross-posts to #wins in Discord for the whole cohort to see.
          </span>
        </span>
        <span
          className={`h-5 w-5 shrink-0 rounded-md border ${
            milestone
              ? "border-phosphor bg-phosphor"
              : "border-line bg-paper"
          }`}
        >
          {milestone && <Check className="h-[18px] w-[18px] text-on-phosphor" />}
        </span>
      </button>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300">
          Saved for {weekLabel}. Your mentors have been pinged.
        </p>
      )}

      {/* Sticky above the tab bar: the three fields are long enough on a phone
          that a button at the bottom of the document is off-screen for the whole
          time you're writing. */}
      <div className="sticky bottom-[calc(3.5rem+var(--safe-bottom))] -mx-5 border-t border-line bg-paper/95 px-5 py-3 backdrop-blur">
        <button
          type="button"
          onClick={save}
          disabled={pending || empty}
          aria-busy={pending}
          className="press inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-md bg-phosphor text-[14px] font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
        >
          {pending
            ? "Saving…"
            : initial
              ? "Update check-in"
              : "Post check-in"}
        </button>
        {empty && (
          <p className="mt-2 text-center text-[11px] text-ink-faint">
            Fill in at least one section.
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        // 4000 is the server's cap. Enforcing it here too means the limit is a
        // thing the keyboard stops at rather than an error after the fact.
        maxLength={4000}
        className="mt-2 block w-full resize-y rounded-xl border border-line bg-wash px-3.5 py-3 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
      />
      <span className="mt-1.5 block text-[11px] leading-snug text-ink-faint">
        {hint}
      </span>
    </label>
  );
}
