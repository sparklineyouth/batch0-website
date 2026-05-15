"use client";
import { useEffect, useRef, useState } from "react";

const REACTIONS = ["👏", "🔥", "🚀", "💡", "❤️", "😂", "🤔", "👀"];

export function ReactionStrip({
  teamId,
  initialCounts,
}: {
  teamId: string;
  initialCounts?: Record<string, number>;
}) {
  const [counts, setCounts] =
    useState<Record<string, number>>(initialCounts ?? {});
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Light polling so counts on screen drift toward what the API has —
  // good enough for a 30-second pitch window without needing realtime.
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/demo-day/reactions?team_id=${encodeURIComponent(teamId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { counts: Record<string, number> };
        setCounts(json.counts ?? {});
      } catch {
        // swallow — transient network errors shouldn't spam the UI
      }
    }, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [teamId]);

  async function react(emoji: string) {
    if (busy) return;
    setBusy(true);
    // Optimistic
    setCounts((c) => ({ ...c, [emoji]: (c[emoji] ?? 0) + 1 }));
    try {
      await fetch("/api/demo-day/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, emoji }),
      });
    } catch {
      // ignore — next poll will reconcile
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => react(e)}
          disabled={busy}
          className="group inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-sm transition active:scale-95 hover:border-white/30"
        >
          <span className="text-lg leading-none">{e}</span>
          <span className="tabular-nums text-xs text-white/60 group-hover:text-white">
            {counts[e] ?? 0}
          </span>
        </button>
      ))}
    </div>
  );
}
