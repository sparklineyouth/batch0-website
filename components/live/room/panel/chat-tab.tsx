"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Pin, PinOff, RotateCcw, Trash2, X } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import {
  chatMessageIsLive,
  normalizeChatMessage,
  MAX_CHAT_LENGTH,
  type AudienceMode,
  type ChatMessage,
} from "@/lib/webinars";
import type { OutboxItem } from "./use-outbox";
import { Chip, Closed, Composer, Empty, RowAction, ROW_ACTIONS } from "./ui";

const NEAR_BOTTOM_PX = 48;

export function ChatTab({
  messages,
  pinned,
  outbox,
  audienceMode,
  isHost,
  closed,
  onSend,
  onRetry,
  onDiscard,
  onRemove,
  onApprove,
  onPin,
}: {
  messages: ChatMessage[];
  pinned: ChatMessage | null;
  outbox: OutboxItem[];
  audienceMode: AudienceMode;
  isHost: boolean;
  /** Ended, for the audience: read-only. */
  closed: boolean;
  onSend: (body: string) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  onRemove: (m: ChatMessage) => void;
  onApprove: (id: string) => void;
  onPin: (id: string, on: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const sent = new Set(messages.map((m) => m.id));
  const pending = outbox.filter((o) => !sent.has(o.id));

  // Follow the conversation only when the reader is at the bottom; otherwise
  // count what arrived and offer a jump. Your own sends always follow.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastSeenId = useRef<string | null>(null);
  const outboxCount = useRef(0);
  const [fresh, setFresh] = useState(0);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setFresh(0);
  }, []);

  useLayoutEffect(() => {
    const last = messages.at(-1)?.id ?? null;
    const prev = lastSeenId.current;
    lastSeenId.current = last;
    const grewOutbox = pending.length > outboxCount.current;
    outboxCount.current = pending.length;
    if (prev === null || grewOutbox) return toBottom();
    if (last === prev) return;
    const from = messages.findIndex((m) => m.id === prev);
    const added = from === -1 ? messages.slice(-1) : messages.slice(from + 1);
    if (atBottom.current || added.some((m) => m.mine)) toBottom();
    else setFresh((n) => n + added.filter((m) => !m.mine).length);
  }, [messages, pending.length, toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    if (atBottom.current) setFresh(0);
  };

  const submit = () => {
    if (!normalizeChatMessage(draft)) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pinned && (
        <div className="flex items-start gap-2 border-b border-line bg-phosphor/10 px-3 py-2">
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phosphor-ink" aria-label="Pinned" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-ink-faint">{pinned.authorName}</p>
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-ink">
              {pinned.body}
            </p>
          </div>
          {isHost && (
            <RowAction label="Unpin" onClick={() => onPin(pinned.id, false)}>
              <PinOff className="h-3.5 w-3.5" />
            </RowAction>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
          className="h-full overflow-y-auto py-2"
        >
          {messages.length === 0 && pending.length === 0 ? (
            <Empty>No messages yet.</Empty>
          ) : (
            <ul>
              {messages.map((m) => (
                <ChatRow
                  key={m.id}
                  message={m}
                  live={chatMessageIsLive(m, audienceMode)}
                  isHost={isHost}
                  onRemove={onRemove}
                  onApprove={onApprove}
                  onPin={onPin}
                />
              ))}
              {pending.map((o) => (
                <li key={o.id} className="px-3 py-1.5" data-outbox={o.state}>
                  <p className="flex items-center gap-2 text-xs text-ink-faint">
                    <span className="font-semibold text-ink">You</span>
                    {o.state === "sending" ? (
                      <span>Sending…</span>
                    ) : (
                      <>
                        <span className="text-red-500" title={o.error ?? undefined}>
                          Not sent{o.error ? ` · ${o.error}` : ""}
                        </span>
                        <RowAction label="Retry" onClick={() => onRetry(o.id)}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </RowAction>
                        <RowAction label="Discard" onClick={() => onDiscard(o.id)}>
                          <X className="h-3.5 w-3.5" />
                        </RowAction>
                      </>
                    )}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm text-ink opacity-70">
                    {o.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        {fresh > 0 && (
          <button
            type="button"
            onClick={toBottom}
            className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-phosphor px-3 py-1 text-xs font-medium text-on-phosphor shadow"
          >
            {fresh} new
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {closed ? (
        <Closed>Chat closed.</Closed>
      ) : (
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          canSubmit={!!normalizeChatMessage(draft)}
          placeholder="Send a message"
          label="Chat message"
          maxLength={MAX_CHAT_LENGTH}
        />
      )}
    </div>
  );
}

function ChatRow({
  message: m,
  live,
  isHost,
  onRemove,
  onApprove,
  onPin,
}: {
  message: ChatMessage;
  /** False while held for a host in a moderated room (own, or a host's queue). */
  live: boolean;
  isHost: boolean;
  onRemove: (m: ChatMessage) => void;
  onApprove: (id: string) => void;
  onPin: (id: string, on: boolean) => void;
}) {
  return (
    <li className="group px-3 py-1.5 hover:bg-ink/5" data-message-id={m.id}>
      <div className="flex min-h-7 items-center gap-2 text-xs">
        <span className={`truncate font-semibold ${m.isHost ? "text-phosphor-ink" : "text-ink"}`}>
          {m.authorName}
        </span>
        {m.isHost && <Chip tone="accent">Host</Chip>}
        <LocalTime value={m.createdAt} mode="time" className="shrink-0 text-ink-faint" />
        {!live && <Chip>Pending</Chip>}
        <div className={`ml-auto ${ROW_ACTIONS}`}>
          {isHost && !live && (
            <RowAction label="Approve" onClick={() => onApprove(m.id)}>
              <Check className="h-3.5 w-3.5" />
            </RowAction>
          )}
          {isHost && (
            <RowAction label={m.pinned ? "Unpin" : "Pin"} onClick={() => onPin(m.id, !m.pinned)}>
              {m.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </RowAction>
          )}
          {(m.mine || isHost) && (
            <RowAction
              label={m.mine ? "Delete" : "Remove"}
              onClick={() => onRemove(m)}
              tone="danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </RowAction>
          )}
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-ink">{m.body}</p>
    </li>
  );
}
