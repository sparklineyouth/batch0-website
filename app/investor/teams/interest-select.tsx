"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setInterest } from "../actions";
import type { InvestorInterestLevel } from "@/lib/types";

const OPTIONS: { value: InvestorInterestLevel | ""; label: string }[] = [
  { value: "", label: "— None —" },
  { value: "watching", label: "Watching" },
  { value: "interested", label: "Interested" },
  { value: "committed", label: "Committed" },
  { value: "passed", label: "Passed" },
];

const COLORS: Record<string, string> = {
  watching: "border-blue-500/40 text-blue-700 dark:text-blue-300",
  interested: "border-phosphor/50 text-phosphor-ink",
  committed: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  passed: "border-line text-ink-faint",
  "": "border-line text-ink-soft",
};

export function InterestSelect({
  teamId,
  initialLevel,
}: {
  teamId: string;
  initialLevel: InvestorInterestLevel | null;
}) {
  const router = useRouter();
  const [level, setLevel] = useState<InvestorInterestLevel | "">(
    initialLevel ?? "",
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as InvestorInterestLevel | "";
    const previous = level;
    setLevel(next);
    setError(undefined);
    start(async () => {
      try {
        const result = await setInterest(teamId, next === "" ? null : next);
        if (!result.ok) {
          setLevel(previous);
          setError(result.error);
          return;
        }
        router.refresh();
      } catch (err: any) {
        setLevel(previous);
        setError(err?.message || "Couldn't update interest. Try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <select
        value={level}
        disabled={pending}
        onChange={onChange}
        aria-label="Set interest level"
        className={`appearance-none rounded-full border bg-transparent px-2.5 py-0.5 font-mono text-xs font-medium uppercase tracking-wider focus:outline-none focus:ring-1 focus:ring-phosphor/40 ${COLORS[level]} ${pending ? "opacity-50" : ""}`}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value} className="bg-paper text-ink">
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="text-[10px] text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
