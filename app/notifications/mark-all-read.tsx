"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { markAllNotificationsRead } from "./actions";

/**
 * `types` scopes the sweep to the tab the button is sitting in — marking the
 * Important tab read shouldn't quietly clear everything else too. Omit it to
 * clear every unread notification.
 */
export function MarkAllRead({ types }: { types?: string[] } = {}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            await markAllNotificationsRead(types);
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
