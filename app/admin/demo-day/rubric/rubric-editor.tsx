"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select, FieldError } from "@/components/ui/input";
import {
  saveRubric,
  deleteCriterion,
  installDefaultRubric,
  type RubricCriterion,
} from "./actions";
import { getActionError } from "@/lib/action-error";
import {
  anchorsToText,
  coerceAnchors,
  parseAnchorLines,
} from "@/lib/demo-day-rubric";

export function RubricEditor({
  initial,
  cohorts,
}: {
  initial: (RubricCriterion & { id: string })[];
  cohorts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RubricCriterion[]>(initial);
  // Anchors are edited as text ("5 = …" per line) and parsed on save, so the
  // textarea holds exactly what was typed while it's being typed. Parsing on
  // every keystroke would eat the half-finished line someone is mid-way
  // through writing.
  const [anchorText, setAnchorText] = useState<string[]>(
    initial.map((r) => anchorsToText(coerceAnchors(r.anchors))),
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  const hasGlobal = rows.some((r) => !r.cohort_id);
  const weightTotal = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);

  function add() {
    setRows((r) => [
      ...r,
      {
        cohort_id: null,
        label: "",
        description: "",
        weight: 20,
        max_score: 5,
        position: r.length,
        anchors: [],
      },
    ]);
    setAnchorText((t) => [...t, ""]);
  }

  function remove(i: number) {
    const target = rows[i];
    if (target.id) {
      if (!confirm("Delete this criterion (and any scores given for it)?"))
        return;
      start(async () => {
        try {
          await deleteCriterion(target.id!);
          setRows((r) => r.filter((_, j) => j !== i));
          setAnchorText((t) => t.filter((_, j) => j !== i));
          setOkMsg("Removed.");
          router.refresh();
        } catch (e) {
          setError(getActionError(e));
        }
      });
    } else {
      setRows((r) => r.filter((_, j) => j !== i));
      setAnchorText((t) => t.filter((_, j) => j !== i));
    }
  }

  function save() {
    setError(undefined);
    setOkMsg(undefined);
    const payload = rows.map((r, i) => ({
      ...r,
      anchors: parseAnchorLines(anchorText[i] ?? ""),
    }));
    start(async () => {
      try {
        await saveRubric(payload);
        setOkMsg("Saved.");
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  function installStandard() {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        const { inserted } = await installDefaultRubric(null);
        setOkMsg(`Installed ${inserted} criteria. Edit anything you like.`);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      {!hasGlobal && (
        <div className="rounded-xl border border-phosphor/30 bg-phosphor/10 p-4">
          <div className="text-sm font-semibold text-ink">
            Start from the standard pitch rubric
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            Five criteria — problem &amp; insight, product &amp; demo, traction
            &amp; evidence, market &amp; business model, and pitch craft, Q&amp;A
            &amp; team — weighted to 100 and scored 0–5 against written bands.
            Installs for all cohorts; edit or delete anything afterwards.
          </p>
          <Button
            className="mt-3"
            size="sm"
            onClick={installStandard}
            disabled={pending}
          >
            {pending ? "Installing…" : "Install standard rubric"}
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {rows.map((r, i) => (
          <div
            key={r.id ?? i}
            className="rounded-xl border border-line bg-wash p-4"
          >
            <div className="grid gap-3 sm:grid-cols-6">
              <div className="sm:col-span-3">
                <Label>Label</Label>
                <Input
                  value={r.label}
                  onChange={(e) =>
                    setRows((rows) =>
                      rows.map((row, j) =>
                        j === i ? { ...row, label: e.target.value } : row,
                      ),
                    )
                  }
                  placeholder="e.g. Problem & insight"
                />
              </div>
              <div className="sm:col-span-3">
                <Label>Cohort (blank = all)</Label>
                <Select
                  value={r.cohort_id ?? ""}
                  onChange={(e) =>
                    setRows((rows) =>
                      rows.map((row, j) =>
                        j === i
                          ? { ...row, cohort_id: e.target.value || null }
                          : row,
                      ),
                    )
                  }
                >
                  <option value="">All cohorts</option>
                  {cohorts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Weight</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  value={r.weight}
                  onChange={(e) =>
                    setRows((rows) =>
                      rows.map((row, j) =>
                        j === i
                          ? { ...row, weight: Number(e.target.value) || 0 }
                          : row,
                      ),
                    )
                  }
                />
                <p className="mt-1 text-[11px] text-ink-faint tabular-nums">
                  {weightTotal > 0
                    ? `${(((Number(r.weight) || 0) / weightTotal) * 100).toFixed(0)}% of the score`
                    : "—"}
                </p>
              </div>
              <div>
                <Label>Max score</Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={r.max_score}
                  onChange={(e) =>
                    setRows((rows) =>
                      rows.map((row, j) =>
                        j === i
                          ? {
                              ...row,
                              max_score:
                                Math.round(Number(e.target.value)) || 1,
                            }
                          : row,
                      ),
                    )
                  }
                />
              </div>
              <div className="sm:col-span-4">
                <Label>Judge hint</Label>
                <Textarea
                  rows={2}
                  value={r.description ?? ""}
                  onChange={(e) =>
                    setRows((rows) =>
                      rows.map((row, j) =>
                        j === i
                          ? { ...row, description: e.target.value }
                          : row,
                      ),
                    )
                  }
                  placeholder="What is this criterion actually asking?"
                />
              </div>
              <div className="sm:col-span-6">
                <Label>Scoring bands</Label>
                <Textarea
                  rows={6}
                  value={anchorText[i] ?? ""}
                  onChange={(e) =>
                    setAnchorText((t) =>
                      t.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                  placeholder={`5 = what full marks looks like\n4 = …\n3 = …\n2 = …\n1 = …`}
                />
                <p className="mt-1 text-[11px] text-ink-faint">
                  One band per line, highest first. Judges see the band next to
                  the number they&apos;re clicking, and founders see the band
                  they landed on when feedback is released.
                </p>
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(i)}
                disabled={pending}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>

      {error && <FieldError>{error}</FieldError>}
      {okMsg && <p className="text-xs text-emerald-700 dark:text-emerald-300">{okMsg}</p>}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="secondary" onClick={add} disabled={pending}>
          + Add criterion
        </Button>
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save rubric"}
        </Button>
      </div>
    </div>
  );
}
