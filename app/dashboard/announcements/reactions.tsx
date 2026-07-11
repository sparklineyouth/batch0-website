"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleReaction } from "./reaction-actions";
import { EMOJIS, type Emoji } from "./emoji";

const EMOJI_GLYPH: Record<Emoji, string> = {
  thumbs_up: "👍",
  heart: "❤️",
  rocket: "🚀",
  party: "🎉",
};

export function Reactions({
  announcementId,
  initialCounts,
  initialMine,
}: {
  announcementId: string;
  initialCounts: Record<Emoji, number>;
  initialMine: Emoji[];
}) {
  const router = useRouter();
  // Optimistic local state so the click feels instant — we still call
  // router.refresh() to reconcile with the server count, but the user
  // sees their click reflected immediately. If the server rejects (rare:
  // network blip), the refresh corrects the UI.
  const [counts, setCounts] = useState<Record<Emoji, number>>(initialCounts);
  const [mine, setMine] = useState<Set<Emoji>>(new Set(initialMine));
  const [pending, start] = useTransition();

  function toggle(emoji: Emoji) {
    const wasMine = mine.has(emoji);
    setCounts((c) => ({
      ...c,
      [emoji]: Math.max(0, (c[emoji] ?? 0) + (wasMine ? -1 : 1)),
    }));
    setMine((m) => {
      const next = new Set(m);
      if (wasMine) next.delete(emoji);
      else next.add(emoji);
      return next;
    });
    start(async () => {
      try {
        await toggleReaction({ announcementId, emoji });
        router.refresh();
      } catch {
        // Revert optimistic state on failure; refresh sets ground truth.
        setCounts((c) => ({
          ...c,
          [emoji]: Math.max(0, (c[emoji] ?? 0) + (wasMine ? 1 : -1)),
        }));
        setMine((m) => {
          const next = new Set(m);
          if (wasMine) next.add(emoji);
          else next.delete(emoji);
          return next;
        });
        router.refresh();
      }
    });
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {EMOJIS.map((e) => {
        const count = counts[e] ?? 0;
        const reacted = mine.has(e);
        return (
          <button
            key={e}
            type="button"
            onClick={() => toggle(e)}
            disabled={pending}
            aria-pressed={reacted}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
              reacted
                ? "border-spark/40 bg-spark/10 text-spark-ink"
                : "border-line bg-wash text-ink-soft hover:border-ink/30 hover:bg-wash"
            } ${count === 0 && !reacted ? "opacity-60" : ""}`}
          >
            <span>{EMOJI_GLYPH[e]}</span>
            {count > 0 && <span className="tabular-nums">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
