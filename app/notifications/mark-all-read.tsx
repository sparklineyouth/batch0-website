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
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink-soft transition hover:border-ink/30 hover:text-ink disabled:opacity-50"
    >
      <CheckCheck className="h-3.5 w-3.5" />
      {pending ? "Marking…" : "Mark all read"}
    </button>
  );
}
