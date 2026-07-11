"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { postDemoDayPitchThreads } from "./discord-actions";

type CohortOption = { id: string; name: string };

export function DemoDayDiscordThreadsButton({
  cohorts,
}: {
  cohorts: CohortOption[];
}) {
  const [cohortId, setCohortId] = useState(cohorts[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  if (!cohortId) return null;

  function go() {
    setResult(undefined);
    setError(undefined);
    if (
      !confirm(
        "Post a pitch embed + reaction buttons in #events for every team in this cohort? Re-running creates new threads — only do this once per Demo Day.",
      )
    ) {
      return;
    }
    start(async () => {
      try {
        const res = await postDemoDayPitchThreads(cohortId);
        if (res.channelMissing) {
          setError(
            "Events channel ID isn't configured. Set it in /admin/discord first.",
          );
          return;
        }
        const ok = res.spawned.filter((s) => s.threadId).length;
        const skipped = res.spawned.filter((s) => s.reason === "no submission").length;
        const failed = res.spawned.filter((s) => s.reason && s.reason !== "no submission").length;
        setResult(
          `Posted ${ok} thread${ok === 1 ? "" : "s"}.${
            skipped ? ` Skipped ${skipped} (no submission).` : ""
          }${failed ? ` ${failed} failed.` : ""}`,
        );
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="mt-6 rounded-xl border border-line bg-wash p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[12rem]">
          <label className="block text-[10px] uppercase tracking-wider text-ink-faint">
            Discord pitch threads
          </label>
          <p className="mt-1 text-xs text-ink-soft">
            Spawn a thread per pitch in #events with audience-reaction
            buttons (🔥 💡 🚀). Clicks land on the leaderboard.
          </p>
        </div>
        <select
          className="rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink"
          value={cohortId}
          onChange={(e) => setCohortId(e.target.value)}
        >
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={go} disabled={pending}>
          {pending ? "Posting…" : "Spawn threads"}
        </Button>
      </div>
      {result && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{result}</p>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
