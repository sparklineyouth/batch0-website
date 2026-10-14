import { Radio } from "lucide-react";

/** The pulsing "Live" pill used on event cards, invite cards and admin lists. */
export function LiveDot() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-red-600 dark:text-red-400">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
      </span>
      <Radio className="h-2.5 w-2.5" />
      Live
    </span>
  );
}
