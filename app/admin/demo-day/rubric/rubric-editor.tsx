"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select, FieldError } from "@/components/ui/input";
import { saveRubric, deleteCriterion, type RubricCriterion } from "./actions";
import { getActionError } from "@/lib/action-error";

export function RubricEditor({
  initial,
  cohorts,
}: {
  initial: (RubricCriterion & { id: string })[];
  cohorts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RubricCriterion[]>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function add() {
    setRows((r) => [
      ...r,
      {
        cohort_id: null,
        label: "",
        description: "",
        weight: 1,
        max_score: 5,
        position: r.length,
      },
    ]);
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
          setOkMsg("Removed.");
          router.refresh();
        } catch (e) {
          setError(getActionError(e));
        }
      });
    } else {
      setRows((r) => r.filter((_, j) => j !== i));
    }
  }

  function save() {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await saveRubric(rows);
        setOkMsg("Saved.");
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        {rows.map((r, i) => (
          <div
            key={r.id ?? i}
            className="rounded-xl border border-white/10 bg-black/30 p-4"
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
                  placeholder="e.g. Problem clarity"
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
                  placeholder="What does a 5/5 here actually look like?"
                />
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
      {okMsg && <p className="text-xs text-emerald-300">{okMsg}</p>}

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
