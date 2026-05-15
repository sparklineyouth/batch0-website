"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError, Label } from "@/components/ui/input";
import { submitScores } from "@/app/admin/demo-day/rubric/actions";

type Criterion = {
  id: string;
  label: string;
  description: string | null;
  weight: number;
  max_score: number;
};

type ExistingScore = {
  criterion_id: string;
  score: number;
  comment: string | null;
};

export function RubricScoreCard({
  teamId,
  criteria,
  existing,
}: {
  teamId: string;
  criteria: Criterion[];
  existing: ExistingScore[];
}) {
  const router = useRouter();
  const initial: Record<string, { score: number | null; comment: string }> = {};
  for (const c of criteria) {
    const e = existing.find((x) => x.criterion_id === c.id);
    initial[c.id] = { score: e?.score ?? null, comment: e?.comment ?? "" };
  }
  const [state, setState] =
    useState<Record<string, { score: number | null; comment: string }>>(initial);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  if (criteria.length === 0) {
    return (
      <Card>
        <p className="text-sm text-white/55">
          No demo-day rubric is configured yet.
        </p>
      </Card>
    );
  }

  function set(cid: string, patch: Partial<{ score: number | null; comment: string }>) {
    setSaved(false);
    setState((s) => ({ ...s, [cid]: { ...s[cid], ...patch } }));
  }

  function save() {
    setErr(undefined);
    const rows = criteria
      .map((c) => ({
        team_id: teamId,
        criterion_id: c.id,
        score: state[c.id].score,
        comment: state[c.id].comment || null,
      }))
      .filter((r): r is { team_id: string; criterion_id: string; score: number; comment: string | null } =>
        typeof r.score === "number",
      );
    if (rows.length === 0) {
      setErr("Pick at least one score before saving.");
      return;
    }
    start(async () => {
      try {
        await submitScores(rows);
        setSaved(true);
        router.refresh();
      } catch (e: any) {
        setErr(e?.message || "Couldn't save. Try again.");
      }
    });
  }

  return (
    <Card>
      <h3 className="text-base font-semibold">Scorecard</h3>
      <p className="text-xs text-white/50">
        Your scores roll into the weighted leaderboard. Visible to admins and
        you.
      </p>
      <div className="mt-5 space-y-5">
        {criteria.map((c) => {
          const cur = state[c.id];
          return (
            <div key={c.id}>
              <div className="flex items-baseline justify-between gap-3">
                <Label>{c.label}</Label>
                <span className="text-[11px] text-white/40">
                  weight {c.weight} · 0–{c.max_score}
                </span>
              </div>
              {c.description && (
                <p className="mt-0.5 text-xs text-white/45">{c.description}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {Array.from({ length: c.max_score + 1 }, (_, n) => n).map(
                  (n) => {
                    const active = cur.score === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() =>
                          set(c.id, { score: active ? null : n })
                        }
                        className={`h-9 w-9 rounded-lg border text-sm font-medium transition ${
                          active
                            ? "border-spark bg-spark/15 text-spark"
                            : "border-white/10 text-white/60 hover:border-white/30 hover:text-white"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  },
                )}
              </div>
              <Textarea
                rows={2}
                value={cur.comment}
                onChange={(e) => set(c.id, { comment: e.target.value })}
                placeholder="Notes (optional)"
                className="mt-2"
                maxLength={1000}
              />
            </div>
          );
        })}
        <div className="flex items-center justify-between">
          <FieldError>{err}</FieldError>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-emerald-300">Saved</span>}
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save scores"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
