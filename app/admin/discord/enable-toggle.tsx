"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDiscordEnabled } from "./actions";
import { Power } from "lucide-react";
import { getActionError } from "@/lib/action-error";

export function EnableToggle({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function flip(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setError(undefined);
    start(async () => {
      try {
        await setDiscordEnabled(next);
        router.refresh();
      } catch (e: any) {
        setEnabled(previous);
        setError(getActionError(e));
      }
    });
  }

  return (
    <div
      className={`rounded-2xl border p-5 ${
        enabled
          ? "border-emerald-400/30 bg-emerald-400/[0.03]"
          : "border-amber-300/40 bg-amber-300/[0.04]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Power
            className={`mt-0.5 h-5 w-5 shrink-0 ${
              enabled ? "text-emerald-300" : "text-amber-300"
            }`}
          />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">
              Discord integration is{" "}
              <span className={enabled ? "text-emerald-300" : "text-amber-200"}>
                {enabled ? "on" : "paused"}
              </span>
            </h2>
            <p className="mt-1 max-w-xl text-xs text-white/55">
              {enabled
                ? "Everything is live: role sync, account linking, slash commands, embeds. Toggle off to pause without uninstalling — students stop seeing the Community link and link button, and no Discord side effects fire."
                : "All Discord traffic is paused. The slash-command endpoint still answers Discord's PING, but commands reply with a 'paused' message. Account linking is disabled. Re-enable any time."}
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle Discord integration"
          disabled={pending}
          onClick={() => flip(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60 ${
            enabled ? "bg-spark" : "bg-white/15"
          } ${pending ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${
              enabled ? "left-[calc(100%-1.375rem)]" : "left-0.5"
            }`}
          />
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
    </div>
  );
}
