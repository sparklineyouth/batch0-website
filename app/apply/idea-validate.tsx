"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

type Result = {
  similars: { idea: string; status: string; overlap: number }[];
  critique: string;
};

export function IdeaValidator({ idea }: { idea: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (idea.trim().length < 30) {
      setErr(
        "Write at least a couple of sentences before pressure-testing.",
      );
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/apply/validate-idea", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json?.error ?? "Try again in a minute.");
        return;
      }
      setResult(json);
    } catch (e: any) {
      setErr(e?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={run}
        disabled={busy}
      >
        <Sparkles className="mr-1 inline h-3.5 w-3.5" />
        {busy ? "Thinking…" : "Pressure-test my idea"}
      </Button>
      {err && (
        <p className="mt-2 text-xs text-amber-600">{err}</p>
      )}
      {result && (
        <div className="mt-3 rounded-xl border border-line bg-paper p-4 text-sm">
          {result.similars.length > 0 ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">
                {result.similars.length} similar idea
                {result.similars.length === 1 ? "" : "s"} have applied
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                That doesn't disqualify you — it means you need to be
                exceptionally clear about how yours is different.
              </p>
              <ul className="mt-3 space-y-2 text-xs text-ink-soft">
                {result.similars.map((s, i) => (
                  <li
                    key={i}
                    className="rounded-lg border border-line bg-wash p-2"
                  >
                    <span className="text-[10px] uppercase tracking-wider text-ink-faint">
                      {s.status}
                    </span>
                    <p className="mt-1 whitespace-pre-wrap">{s.idea}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-emerald-600">
              No close matches in accepted past applications.
            </p>
          )}
          <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Tightening suggestions
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
            {result.critique}
          </p>
        </div>
      )}
    </div>
  );
}
