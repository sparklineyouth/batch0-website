"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { saveMyReview } from "./review-server-actions";
import { getActionError } from "@/lib/action-error";

const DIMS: { key: keyof ScoreState; label: string; hint: string }[] = [
  { key: "idea", label: "Idea", hint: "Is the problem real, big enough, well understood?" },
  { key: "founder", label: "Founder", hint: "Agency, follow-through, founder/market fit." },
  { key: "motivation", label: "Motivation", hint: "Why this, why now, why them." },
  { key: "feasibility", label: "Feasibility", hint: "Can they actually ship in 4 weeks?" },
  { key: "fit", label: "Fit", hint: "Will Sparkline Youth help them more than other paths?" },
];

const DECISIONS = [
  { value: "strong_accept", label: "Strong accept" },
  { value: "accept", label: "Accept" },
  { value: "borderline", label: "Borderline" },
  { value: "reject", label: "Reject" },
  { value: "strong_reject", label: "Strong reject" },
];

type ScoreState = {
  idea: number | null;
  founder: number | null;
  motivation: number | null;
  feasibility: number | null;
  fit: number | null;
  decision: string | null;
  notes: string;
};

export function ReviewScorecard({
  applicationId,
  existing,
}: {
  applicationId: string;
  existing: Partial<ScoreState> | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ScoreState>({
    idea: existing?.idea ?? null,
    founder: existing?.founder ?? null,
    motivation: existing?.motivation ?? null,
    feasibility: existing?.feasibility ?? null,
    fit: existing?.fit ?? null,
    decision: existing?.decision ?? null,
    notes: existing?.notes ?? "",
  });
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  function set<K extends keyof ScoreState>(k: K, v: ScoreState[K]) {
    setSaved(false);
    setState((s) => ({ ...s, [k]: v }));
  }

  function save(submit: boolean) {
    setErr(undefined);
    start(async () => {
      try {
        await saveMyReview({
          applicationId,
          idea: state.idea,
          founder: state.founder,
          motivation: state.motivation,
          feasibility: state.feasibility,
          fit: state.fit,
          decision: (state.decision as any) ?? null,
          notes: state.notes || null,
          submit,
        });
        setSaved(true);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      {DIMS.map(({ key, label, hint }) => (
        <div key={key as string}>
          <div className="flex items-baseline justify-between">
            <Label>{label}</Label>
            <span className="text-[11px] text-ink-faint">{hint}</span>
          </div>
          <div className="mt-1.5 flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => {
              const active = state[key] === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() =>
                    set(key, active ? (null as any) : (n as any))
                  }
                  className={`h-9 w-9 rounded-lg border text-sm font-medium tabular-nums transition ${
                    active
                      ? "border-spark/30 bg-spark/15 text-spark-ink"
                      : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <Label>Recommendation</Label>
        <Select
          value={state.decision ?? ""}
          onChange={(e) => set("decision", e.target.value || null)}
        >
          <option value="">— Choose —</option>
          {DECISIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Notes (private to reviewers)</Label>
        <Textarea
          value={state.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={3}
          placeholder="Why these scores? What do you want the next reviewer to dig into?"
          maxLength={2500}
        />
      </div>
      <div className="flex items-center justify-between">
        <FieldError>{err}</FieldError>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-700 dark:text-emerald-300">Saved</span>}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save(false)}
            disabled={pending}
          >
            {pending ? "Saving…" : "Save draft"}
          </Button>
          <Button onClick={() => save(true)} disabled={pending || !state.decision}>
            {pending ? "Submitting…" : "Submit review"}
          </Button>
        </div>
      </div>
    </div>
  );
}
