"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import type { DmMessage } from "@/lib/dm";
import { removeMessage } from "../actions";

/**
 * The reported conversation, read-only, with one destructive affordance:
 * removing a message. It disappears for BOTH participants, which is the point
 * when the content itself is the problem — and is why it's confirmed and
 * audited rather than a single click.
 */
export function Transcript({
  conversationId,
  messages,
  canModerate = true,
}: {
  conversationId: string;
  messages: DmMessage[];
  /** False for a moderator who is one of the two people in it. */
  canModerate?: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = messages.find((m) => m.id === pendingId) ?? null;

  async function remove() {
    if (!pendingId) return;
    setBusy(true);
    try {
      const res = await removeMessage({ messageId: pendingId, conversationId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      router.refresh();
    } catch {
      setError("Couldn't remove that message. Try again.");
    } finally {
      setBusy(false);
      setPendingId(null);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className="border-b border-line px-4 py-2 text-xs text-red-400">
          {error}
        </p>
      )}
      {messages.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-ink-faint">
          No messages in this conversation.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {messages.map((m) => (
            <li key={m.id} className="group px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium text-ink">{m.senderName}</p>
                <div className="flex shrink-0 items-center gap-2">
                  <p className="text-[10px] font-mono tabular-nums text-ink-faint">
                    <LocalTime value={m.createdAt} />
                  </p>
                  {canModerate && (
                  <button
                    type="button"
                    onClick={() => setPendingId(m.id)}
                    aria-label={`Remove message from ${m.senderName}`}
                    // Hover-only with a pointer; always shown on touch screens,
                    // where there is no hover to reveal it.
                    className="press flex h-6 w-6 items-center justify-center rounded-md text-ink-faint opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400 [@media(hover:none)]:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  )}
                </div>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft [overflow-wrap:anywhere]">
                {m.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!pendingId}
        title="Remove this message?"
        description={
          <div className="space-y-2">
            <p className="text-sm text-ink-soft">
              It disappears for both people in the conversation. This can&apos;t
              be undone, and it&apos;s recorded in the audit log.
            </p>
            {target && (
              <p className="max-h-24 overflow-y-auto rounded-md border border-line bg-wash px-3 py-2 text-xs text-ink-soft">
                {target.body}
              </p>
            )}
          </div>
        }
        confirmLabel="Remove"
        destructive
        pending={busy}
        onConfirm={remove}
        onCancel={() => setPendingId(null)}
      />
    </>
  );
}
