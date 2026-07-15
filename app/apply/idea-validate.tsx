"use client";
import { useState } from "react";

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
      {/* squared secondary button, key-press shift, no icon — the /apply
          surface allows no icons beyond the page-title flag */}
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="press inline-flex h-8 items-center justify-center border border-line bg-paper px-3 text-xs font-medium lowercase text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
      >
        {busy ? "Thinking…" : "Pressure-test my idea"}
      </button>
      {err && (
        <p className="mt-2 text-xs text-red-500">{err}</p>
      )}
      {result && (
        <div className="mt-3 border border-line p-4 text-sm">
          {result.similars.length > 0 ? (
            <>
              <p className="font-mono text-xs font-medium lowercase tracking-[0.06em] text-phosphor-ink">
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
                    className="border border-line p-2"
                  >
                    <span className="font-mono text-[10px] lowercase tracking-[0.06em] text-ink-faint">
                      {s.status}
                    </span>
                    <p className="mt-1 whitespace-pre-wrap">{s.idea}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-ink-soft">
              No close matches in accepted past applications.
            </p>
          )}
          <p className="mt-4 font-mono text-xs font-medium lowercase tracking-[0.06em] text-ink-faint">
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
