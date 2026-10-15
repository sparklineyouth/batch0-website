"use client";
import { useCallback, useEffect, useState } from "react";
import { badgeText } from "@/lib/chat-access";
import { fetchAttention } from "@/app/chat/actions";
import { usePing } from "./use-chat-live";

/**
 * The count on the "Chat" nav link: DMs and groups with something unread,
 * plus channel mentions. Rides the chat bells (one per burst) for instant
 * updates, with a slow poll as the safety net — the same pattern as the
 * notification bell. Renders nothing at zero.
 */
export function ChatNavBadge({ userId }: { userId?: string | null }) {
  const [n, setN] = useState(0);
  const refresh = useCallback(() => {
    fetchAttention().then(setN).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return (
    <>
      {userId ? <PingListener userId={userId} onPing={refresh} /> : null}
      {n > 0 ? (
        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-phosphor px-1.5 font-mono text-[10px] font-semibold text-on-phosphor">
          {badgeText(n)}
        </span>
      ) : null}
    </>
  );
}

function PingListener({ userId, onPing }: { userId: string; onPing: () => void }) {
  usePing(userId, onPing);
  return null;
}
