"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError, Label } from "@/components/ui/input";
import { submitScores } from "@/app/admin/demo-day/rubric/actions";
import {
  anchorForScore,
  coerceAnchors,
  type RubricAnchor,
} from "@/lib/demo-day-rubric";

type Criterion = {
  id: string;
  label: string;
  description: string | null;
  weight: number;
  max_score: number;
  anchors?: RubricAnchor[] | null;
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
  // The band under the buttons follows the pointer before it follows the
  // selection: a judge deciding between a 3 and a 4 wants to read both
  // without committing to either first.
  const [hover, setHover] = useState<{ cid: string; score: number } | null>(
    null,
  );

  if (criteria.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">
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
      <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">Scorecard</h3>
      <p className="text-xs text-ink-faint">
        Your scores roll into the weighted leaderboard. Visible to admins and
        you — the team only sees this card if an admin releases their
        feedback, and never with your name on it.
      </p>
      <div className="mt-5 space-y-5">
        {criteria.map((c) => {
          const cur = state[c.id];
          const anchors = coerceAnchors(c.anchors);
          const shownScore =
            hover?.cid === c.id ? hover.score : cur.score;
          const band = anchorForScore(anchors, shownScore);
          return (
            <div key={c.id}>
              <div className="flex items-baseline justify-between gap-3">
                <Label>{c.label}</Label>
                <span className="text-[11px] text-ink-faint tabular-nums">
                  {weightPct(c, criteria)} · 0–{c.max_score}
                </span>
              </div>
              {c.description && (
                <p className="mt-0.5 text-xs text-ink-faint">{c.description}</p>
              )}
              <div
                className="mt-2 flex flex-wrap gap-2"
                onMouseLeave={() => setHover(null)}
              >
                {Array.from({ length: c.max_score + 1 }, (_, n) => n).map(
                  (n) => {
                    const active = cur.score === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onMouseEnter={() => setHover({ cid: c.id, score: n })}
                        onFocus={() => setHover({ cid: c.id, score: n })}
                        onClick={() =>
                          set(c.id, { score: active ? null : n })
                        }
                        className={`h-9 w-9 rounded-lg border text-sm font-medium tabular-nums transition ${
                          active
                            ? "border-phosphor bg-phosphor/15 text-phosphor-ink"
                            : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  },
                )}
              </div>
              {anchors.length > 0 && (
                <p
                  className={`mt-2 min-h-[2.5rem] rounded-lg border border-line bg-wash px-3 py-2 text-xs ${
                    band ? "text-ink-soft" : "text-ink-faint"
                  }`}
                >
                  {band ? (
                    <>
                      <strong className="text-ink tabular-nums">
                        {shownScore}
                      </strong>{" "}
                      — {band}
                    </>
                  ) : (
                    "Hover a number to read what it means."
                  )}
                </p>
              )}
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
            {saved && <span className="text-xs text-emerald-700 dark:text-emerald-300">Saved</span>}
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save scores"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Weight as a share of this team's applicable rubric. The raw number means
 * nothing on its own — "20" is a fifth of the score in one cohort and a
 * twentieth in another — and a judge calibrating how hard to think about a
 * criterion is asking for the share.
 */
function weightPct(c: Criterion, all: Criterion[]): string {
  const total = all.reduce((s, x) => s + (Number(x.weight) || 0), 0);
  if (total <= 0) return "unweighted";
  return `${Math.round(((Number(c.weight) || 0) / total) * 100)}% of score`;
}
