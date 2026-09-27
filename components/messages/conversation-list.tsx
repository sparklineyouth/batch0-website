"use client";
import { MessageSquarePlus, Search } from "lucide-react";
import { formatRelativeTime } from "@/lib/format-time";
import type { DmInboxRow } from "@/lib/dm";
import { Avatar } from "@/components/messages/person";

/**
 * The inbox list. Pure presentation — the popup and the full page both own
 * their own fetching and pass rows in, so the list looks identical in both.
 */
export function ConversationList({
  rows,
  activeId,
  onOpen,
  onNew,
  loading = false,
  compact = false,
}: {
  rows: DmInboxRow[];
  activeId?: string | null;
  onOpen: (id: string) => void;
  onNew?: () => void;
  loading?: boolean;
  compact?: boolean;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-ink-faint">Loading…</div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-line bg-wash">
          <Search className="h-4 w-4 text-ink-faint" />
        </div>
        <p className="mt-3 text-sm text-ink-soft">No conversations yet</p>
        <p className="mt-1 text-xs text-ink-faint">
          Search for anyone at batch0 and start one.
        </p>
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className="press mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-phosphor-ink hover:opacity-80"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New message
          </button>
        )}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => {
        const active = row.id === activeId;
        return (
          <li key={row.id} className="relative">
            {row.unread && (
              <span
                aria-hidden
                className="absolute left-0 top-0 h-full w-[2px] bg-phosphor"
              />
            )}
            <button
              type="button"
              onClick={() => onOpen(row.id)}
              aria-current={active ? "true" : undefined}
              className={`press flex w-full items-start gap-2.5 text-left hover:bg-wash ${
                compact ? "px-3 py-2.5" : "px-4 py-3"
              } ${active ? "bg-wash" : ""}`}
            >
              <Avatar person={row.other} size={compact ? "sm" : "md"} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className={`truncate text-sm ${
                      row.unread ? "font-semibold text-ink" : "font-medium text-ink-soft"
                    }`}
                  >
                    {row.other.name}
                  </span>
                  {row.lastMessageAt && (
                    <span className="shrink-0 text-[10px] font-mono tabular-nums text-ink-faint">
                      {formatRelativeTime(row.lastMessageAt)}
                    </span>
                  )}
                </span>
                <span
                  className={`mt-0.5 line-clamp-1 block text-xs ${
                    row.unread ? "text-ink-soft" : "text-ink-faint"
                  }`}
                >
                  {row.lastMessagePreview
                    ? `${row.lastFromSelf ? "You: " : ""}${row.lastMessagePreview}`
                    : "No messages yet"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
