"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { markAllNotificationsRead } from "./actions";

export function MarkAllRead() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            await markAllNotificationsRead();
          } catch {}
          router.refresh();
        })
      }
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-950/40 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:border-white/20 hover:text-white disabled:opacity-50"
    >
      <CheckCheck className="h-3.5 w-3.5" />
      {pending ? "Marking…" : "Mark all read"}
    </button>
  );
}
