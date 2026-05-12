"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError, Label } from "@/components/ui/input";
import { upsertPitchScore } from "./actions";

type Score = {
  problem: number | null;
  traction: number | null;
  team_score: number | null;
  ask: number | null;
  notes: string | null;
};

const RUBRIC: { key: keyof Score; label: string; hint: string }[] = [
  { key: "problem", label: "Problem", hint: "Real, urgent, well understood" },
  { key: "traction", label: "Traction", hint: "Evidence of progress / validation" },
  { key: "team_score", label: "Team", hint: "Founder/market fit, agency" },
  { key: "ask", label: "Ask", hint: "Clarity + believability of the ask" },
];

export function ScoreCard({
  teamId,
  existing,
}: {
  teamId: string;
  existing: Score | null;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<Score>({
    problem: existing?.problem ?? null,
    traction: existing?.traction ?? null,
    team_score: existing?.team_score ?? null,
    ask: existing?.ask ?? null,
    notes: existing?.notes ?? null,
  });
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  function set<K extends keyof Score>(k: K, v: Score[K]) {
    setSaved(false);
    setScores((s) => ({ ...s, [k]: v }));
  }

  function save() {
    setErr(undefined);
    start(async () => {
      try {
        await upsertPitchScore({ teamId, ...scores });
        setSaved(true);
        router.refresh();
      } catch (e: any) {
        setErr(e.message);
      }
    });
  }

  return (
    <Card>
      <h3 className="text-base font-semibold">Your scorecard</h3>
      <p className="text-xs text-white/50">
        Private to you and admins until Demo Day aggregates results. 1 = weak,
        5 = exceptional.
      </p>

      <div className="mt-5 space-y-4">
        {RUBRIC.map(({ key, label, hint }) => (
          <div key={key as string}>
            <div className="flex items-baseline justify-between">
              <Label>{label}</Label>
              <span className="text-[11px] text-white/40">{hint}</span>
            </div>
            <div className="mt-1 flex gap-2">
              {[1, 2, 3, 4, 5].map((n) => {
                const active = scores[key] === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() =>
                      set(key, active ? (null as any) : (n as any))
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
              })}
            </div>
          </div>
        ))}
        <div>
          <Label htmlFor="score-notes">Notes</Label>
          <Textarea
            id="score-notes"
            value={scores.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            placeholder="Why these scores? What's the next thing to dig into?"
            maxLength={2000}
          />
        </div>
        <div className="flex items-center justify-between">
          <FieldError>{err}</FieldError>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-xs text-emerald-300">Saved</span>
            )}
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save scorecard"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
