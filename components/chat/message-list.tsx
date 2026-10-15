"use client";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Copy,
  CornerUpLeft,
  Ban,
  Flag,
  FileText,
  Info,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
  Video,
} from "lucide-react";
import { canDeleteMessage, canEditMessage, sortedReactions, type ChatViewer } from "@/lib/chat-access";
import { decodeMentions, encodeMentions, plainText, type PickedMention } from "@/lib/chat-format";
import { layoutMessages } from "@/lib/chat-view";
import { attachmentKind, chatFileHref, formatBytes, isInlineImage } from "@/lib/chat-files-rules";
import { Avatar, RoleTag } from "./avatar";
import { MessageMarkup, type MarkupContext } from "./markup";
import { EmojiGrid, MenuItem, Popover } from "./popover";
import { clockTime, dayLabel, imeComposing, stampLabel } from "./util";
import type { ChannelInfo, ChatPerson, ChatViewerInfo, UiMessage } from "./types";

const NEAR_BOTTOM_PX = 120;

export type MessageActions = {
  onReply: (m: UiMessage) => void;
  onEdit: (id: string, body: string) => Promise<string | null>;
  onDelete: (m: UiMessage) => void;
  onReact: (id: string, emoji: string) => void;
  onPin: (id: string) => void;
  onReport: (m: UiMessage) => void;
  onBlock: (userId: string) => void;
  onRetry: (m: UiMessage) => void;
  onDiscard: (id: string) => void;
  onMessagePerson: (userId: string) => void;
};

export function MessageList({
  viewer,
  channel,
  messages,
  people,
  online,
  blocked,
  cursor,
  markup,
  hasMoreBefore,
  loadingOlder,
  onLoadOlder,
  hasMoreAfter = false,
  onJumpToPresent,
  jumpTo,
  onJumped,
  editingId,
  setEditingId,
  actions,
  onNearBottom,
  emptyHint,
}: {
  viewer: ChatViewerInfo;
  channel: ChannelInfo | null;
  messages: UiMessage[];
  people: Record<string, ChatPerson>;
  online: Set<string>;
  blocked: readonly string[];
  cursor: string | null;
  markup: MarkupContext;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Showing a window around a jump target, with newer messages not loaded. */
  hasMoreAfter?: boolean;
  onJumpToPresent?: () => void;
  jumpTo: string | null;
  onJumped: () => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  actions: MessageActions;
  onNearBottom: (near: boolean) => void;
  emptyHint: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Day dividers are in the viewer's timezone, which the server can't know.
  useEffect(() => setOffset(new Date().getTimezoneOffset()), []);

  const rows = useMemo(
    () => layoutMessages(messages, { viewerId: viewer.id, cursor, offsetMinutes: offset }),
    [messages, viewer.id, cursor, offset],
  );

  const channelKey = channel?.id ?? "draft";
  const contentRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevCount = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);
  const opened = useRef<string | null>(null);
  // Until the reader scrolls themselves, the opening position is re-applied
  // as late content (day dividers, fonts, images) changes the heights.
  const settled = useRef(false);
  const programmatic = useRef(false);

  const isNearBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const setScroll = (top: number) => {
    const el = scrollRef.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = top;
    prevHeight.current = el.scrollHeight;
  };

  /** Open at the bottom — or at the "new" line when the unread run is taller than the screen. */
  const anchorOpening = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const line = el.querySelector<HTMLElement>("[data-new-line]");
    const lineY = line ? line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : null;
    const atLine = lineY !== null && lineY - 80 < max;
    setScroll(atLine ? Math.max(0, (lineY as number) - 80) : max);
    nearBottom.current = !atLine || isNearBottom();
    onNearBottom(nearBottom.current);
  };

  // Scroll: open at the bottom (or the "new" line / a jump target), hold the
  // reader's place when older messages load above, follow new ones only when
  // the reader is already at the bottom (or wrote it).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = messages[0]?.id ?? null;
    if (opened.current !== channelKey) {
      opened.current = channelKey;
      settled.current = false;
      prevCount.current = messages.length;
      prevFirst.current = first;
      setShowJump(false);
      if (!jumpTo) anchorOpening();
      return;
    }
    if (first !== prevFirst.current && messages.length > prevCount.current && prevFirst.current) {
      // Older messages loaded above: hold the reader's place.
      setScroll(el.scrollTop + (el.scrollHeight - prevHeight.current));
    } else if (messages.length > prevCount.current) {
      const last = messages[messages.length - 1];
      if (nearBottom.current || last?.senderId === viewer.id) setScroll(el.scrollHeight);
      else setShowJump(true);
    }
    prevCount.current = messages.length;
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, channelKey]);

  // Back to the present after reading around a jump target: the newest page
  // replaced the window, so land at its bottom. (Same channel only — opening
  // another one anchors as usual, at its "new" line.)
  const wasAround = useRef<{ key: string; on: boolean }>({ key: channelKey, on: hasMoreAfter });
  useLayoutEffect(() => {
    if (wasAround.current.on && !hasMoreAfter && wasAround.current.key === channelKey) {
      const el = scrollRef.current;
      if (el) setScroll(el.scrollHeight);
      nearBottom.current = true;
      onNearBottom(true);
      setShowJump(false);
    }
    wasAround.current = { key: channelKey, on: hasMoreAfter };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreAfter, channelKey]);

  // Day dividers arrive after hydration: re-anchor if the reader hasn't moved.
  useLayoutEffect(() => {
    if (offset !== null && !settled.current && !jumpTo) anchorOpening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  // Images and fonts change heights after render: stay pinned to the bottom
  // when that's where the reader is.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (!settled.current && !jumpTo) anchorOpening();
      else if (nearBottom.current) setScroll(el.scrollHeight);
    });
    ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey]);

  useEffect(() => {
    if (!jumpTo) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${jumpTo}"]`);
    if (el) {
      settled.current = true;
      el.scrollIntoView({ block: "center" });
      setFlash(jumpTo);
      const t = setTimeout(() => setFlash(null), 2000);
      onJumped();
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (programmatic.current) programmatic.current = false;
    else settled.current = true;
    const near = isNearBottom();
    if (near !== nearBottom.current) {
      nearBottom.current = near;
      onNearBottom(near);
    }
    if (near) setShowJump(false);
    if (settled.current && el.scrollTop < 200 && hasMoreBefore && !loadingOlder) onLoadOlder();
  };

  const toBottom = () => {
    setShowJump(false);
    // Newer messages aren't loaded yet: the bottom of this window isn't now.
    if (hasMoreAfter && onJumpToPresent) return onJumpToPresent();
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const viewerRules: ChatViewer = {
    userId: viewer.id,
    staff: viewer.staff,
    vetted: viewer.vetted,
    cohortIds: [],
    teamIds: [],
    memberOf: channel && channel.kind !== "channel" && !channel.moderatorView ? [channel.id] : [],
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-3 pt-6">
          {hasMoreBefore ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={loadingOlder}
                className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-wash"
              >
                {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Load older messages
              </button>
            </div>
          ) : (
            <div className="px-4 pb-4 md:px-6">{emptyHint}</div>
          )}
          {rows.map((r) => {
            if (r.t === "day") {
              return (
                <div key={r.key} className="my-3 flex items-center gap-3 px-4 md:px-6" role="separator">
                  <span className="h-px flex-1 bg-line" />
                  <span className="font-mono text-[11px] text-ink-faint">{dayLabel(r.dayKey)}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              );
            }
            if (r.t === "new") {
              return (
                <div key="new" data-new-line className="my-2 flex items-center gap-3 px-4 md:px-6" role="separator">
                  <span className="h-px flex-1 bg-phosphor" />
                  <span className="rounded bg-phosphor px-1.5 py-px font-mono text-[10px] font-semibold text-on-phosphor">NEW</span>
                </div>
              );
            }
            return (
              <MessageItem
                key={r.key}
                m={r.m}
                head={r.head}
                viewer={viewer}
                rules={viewerRules}
                channel={channel}
                sender={r.m.senderId ? people[r.m.senderId] : null}
                people={people}
                online={!!r.m.senderId && online.has(r.m.senderId)}
                blocked={!!r.m.senderId && blocked.includes(r.m.senderId)}
                markup={markup}
                editing={editingId === r.m.id}
                setEditingId={setEditingId}
                flash={flash === r.m.id}
                actions={actions}
                mounted={offset !== null}
              />
            );
          })}
          {hasMoreAfter ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={onJumpToPresent}
                className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-wash"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                You're reading older messages · Jump to present
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-phosphor px-3 py-1.5 text-xs font-semibold text-on-phosphor shadow-cta"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          New messages
        </button>
      ) : null}
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  m,
  head,
  viewer,
  rules,
  channel,
  sender,
  people,
  online,
  blocked,
  markup,
  editing,
  setEditingId,
  flash,
  actions,
  mounted,
}: {
  m: UiMessage;
  head: boolean;
  viewer: ChatViewerInfo;
  rules: ChatViewer;
  channel: ChannelInfo | null;
  sender: ChatPerson | null | undefined;
  people: Record<string, ChatPerson>;
  online: boolean;
  blocked: boolean;
  markup: MarkupContext;
  editing: boolean;
  setEditingId: (id: string | null) => void;
  flash: boolean;
  actions: MessageActions;
  /**
   * Times are in the viewer's zone and locale, which the server rendering
   * this can't know: render them only once mounted, or hydration mismatches.
   */
  mounted: boolean;
}) {
  const [menu, setMenu] = useState<"emoji" | "more" | null>(null);
  const [reveal, setReveal] = useState(false);
  const name = m.senderId ? (sender?.name ?? "Deleted account") : "batch0";
  const mine = m.senderId === viewer.id;
  const live = !m.pending && !m.failed;
  // A frozen DM or group (a block, a departed account, the safeguarding rule,
  // a fine) takes no edits, reactions or pins either — the server refuses
  // them, so don't offer them. A text channel you can't post in still takes
  // reactions (#announcements), just not edits.
  const readOnly = !channel || channel.archived || channel.moderatorView || (channel.kind !== "channel" && !channel.compose.ok);
  const mentioned = !mine && (m.mentions.includes(viewer.id) || m.mentionEveryone);

  if (m.kind === "system") {
    return (
      <div data-mid={m.id} className="flex items-start gap-2 px-4 py-1 text-xs text-ink-faint md:px-6">
        {/pinned a message/.test(m.body) ? (
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0">
          <MessageMarkup body={m.body} ctx={markup} compact />
        </span>
        <span className="shrink-0 font-mono text-[10px]">{mounted ? clockTime(m.createdAt) : ""}</span>
      </div>
    );
  }

  if (blocked && !reveal) {
    return (
      <div data-mid={m.id} className="px-4 py-1 md:px-6">
        <button
          type="button"
          onClick={() => setReveal(true)}
          className="ml-12 text-xs text-ink-faint underline-offset-2 hover:underline"
        >
          Message from someone you blocked — show
        </button>
      </div>
    );
  }

  const canEdit = live && !readOnly && !!channel?.compose.ok && canEditMessage({ senderId: m.senderId, kind: m.kind, deletedAt: null }, rules);
  const canDelete =
    live &&
    !(channel?.archived && !viewer.staff) &&
    canDeleteMessage({ senderId: m.senderId, kind: m.kind, deletedAt: null }, { id: channel?.id ?? "", kind: channel?.kind ?? "dm" }, rules);
  const reactions = sortedReactions(m.reactions);

  return (
    <div
      data-mid={m.id}
      className={`group relative px-4 md:px-6 ${head ? "mt-3 pt-0.5" : ""} ${
        mentioned ? "border-l-2 border-phosphor bg-phosphor/10" : "border-l-2 border-transparent"
      } ${flash ? "bg-phosphor/20" : ""} ${m.pending ? "opacity-60" : ""} hover:bg-wash/70`}
    >
      {head && m.replyTo ? <ReplyQuote reply={m.replyTo} people={people} markup={markup} /> : null}
      <div className="flex gap-3">
        <div className="w-9 shrink-0">
          {head ? (
            <button type="button" onClick={() => m.senderId && actions.onMessagePerson(m.senderId)} aria-label={`Message ${name}`}>
              <Avatar name={name} online={online} size={36} />
            </button>
          ) : (
            <span className="invisible block pt-1 text-right font-mono text-[10px] text-ink-faint group-hover:visible">
              {mounted ? clockTime(m.createdAt) : ""}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 pb-0.5">
          {head ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold text-ink">{name}</span>
              <RoleTag person={sender} />
              <time dateTime={m.createdAt} className="font-mono text-[11px] text-ink-faint">
                {mounted ? stampLabel(m.createdAt) : ""}
              </time>
              {m.pinnedAt ? <Pin className="h-3 w-3 text-phosphor-ink" aria-label="Pinned" /> : null}
            </div>
          ) : null}

          {editing ? (
            <EditBox
              m={m}
              people={people}
              onCancel={() => setEditingId(null)}
              onSave={async (body) => {
                const err = await actions.onEdit(m.id, body);
                if (!err) setEditingId(null);
                return err;
              }}
            />
          ) : (
            <div className="text-[15px] leading-relaxed text-ink">
              {m.body ? <MessageMarkup body={m.body} ctx={markup} /> : null}
              {m.editedAt ? <span className="ml-1 text-[10px] text-ink-faint">(edited)</span> : null}
            </div>
          )}

          {m.attachments.length > 0 ? <Attachments m={m} /> : null}

          {reactions.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {reactions.map((r) => {
                const mineToo = r.userIds.includes(viewer.id);
                const who = r.userIds.map((id) => (id === viewer.id ? "You" : (people[id]?.name ?? "Someone"))).join(", ");
                return (
                  <button
                    key={r.emoji}
                    type="button"
                    disabled={!live || readOnly}
                    onClick={() => actions.onReact(m.id, r.emoji)}
                    title={`${who} reacted with ${r.emoji}`}
                    className={`inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs ${
                      mineToo ? "border-phosphor bg-phosphor/15 text-ink" : "border-line bg-paper text-ink-soft hover:border-ink/30"
                    }`}
                  >
                    <span>{r.emoji}</span>
                    <span className="font-mono text-[11px]">{r.userIds.length}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {m.failed ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {m.failed}{" "}
              <button type="button" className="underline" onClick={() => actions.onRetry(m)}>
                Retry
              </button>{" "}
              ·{" "}
              <button type="button" className="underline" onClick={() => actions.onDiscard(m.id)}>
                Discard
              </button>
            </p>
          ) : null}
        </div>
      </div>

      {live && !editing ? (
        <div
          className={`absolute -top-3 right-4 z-10 items-center rounded-md border border-line bg-paper shadow-[0_2px_8px_rgb(0_0_0/0.08)] md:right-6 ${
            menu ? "flex" : "hidden group-hover:flex group-focus-within:flex"
          }`}
        >
          {!readOnly ? (
            <ToolbarButton label="Add a reaction" onClick={() => setMenu(menu === "emoji" ? null : "emoji")}>
              <SmilePlus className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          {!readOnly && channel?.compose.ok ? (
            <ToolbarButton label="Reply" onClick={() => { setMenu(null); actions.onReply(m); }}>
              <CornerUpLeft className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          {canEdit ? (
            <ToolbarButton label="Edit" onClick={() => { setMenu(null); setEditingId(m.id); }}>
              <Pencil className="h-4 w-4" />
            </ToolbarButton>
          ) : null}
          <ToolbarButton label="More" onClick={() => setMenu(menu === "more" ? null : "more")}>
            <MoreHorizontal className="h-4 w-4" />
          </ToolbarButton>
          <Popover open={menu === "emoji"} onClose={() => setMenu(null)} className="right-0 top-9">
            <EmojiGrid
              onPick={(e) => {
                setMenu(null);
                actions.onReact(m.id, e);
              }}
            />
          </Popover>
          <Popover open={menu === "more"} onClose={() => setMenu(null)} className="right-0 top-9 w-52" >
            <div role="menu">
              {channel?.canPin && !readOnly ? (
                <MenuItem icon={m.pinnedAt ? PinOff : Pin} onClick={() => { setMenu(null); actions.onPin(m.id); }}>
                  {m.pinnedAt ? "Unpin" : "Pin message"}
                </MenuItem>
              ) : null}
              <MenuItem
                icon={Copy}
                onClick={() => {
                  setMenu(null);
                  void navigator.clipboard?.writeText(plainText(m.body, (id) => people[id]?.name, (id) => markup.channelName(id), 4000)).catch(() => undefined);
                }}
              >
                Copy text
              </MenuItem>
              {!mine && m.senderId ? (
                <MenuItem icon={MessageSquare} onClick={() => { setMenu(null); actions.onMessagePerson(m.senderId!); }}>
                  Message {name.split(" ")[0]}
                </MenuItem>
              ) : null}
              {canDelete ? (
                <MenuItem icon={Trash2} danger onClick={() => { setMenu(null); actions.onDelete(m); }}>
                  {mine ? "Delete message" : "Remove message"}
                </MenuItem>
              ) : null}
              {!mine && m.senderId && !channel?.moderatorView ? (
                <>
                  <MenuItem icon={Flag} danger onClick={() => { setMenu(null); actions.onReport(m); }}>
                    Report message
                  </MenuItem>
                  <MenuItem icon={Ban} danger onClick={() => { setMenu(null); actions.onBlock(m.senderId!); }}>
                    {blocked ? "Unblock" : "Block"} {name.split(" ")[0]}
                  </MenuItem>
                </>
              ) : null}
            </div>
          </Popover>
        </div>
      ) : null}
    </div>
  );
});

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center text-ink-soft hover:bg-wash hover:text-ink"
    >
      {children}
    </button>
  );
}

function ReplyQuote({
  reply,
  people,
  markup,
}: {
  reply: NonNullable<UiMessage["replyTo"]>;
  people: Record<string, ChatPerson>;
  markup: MarkupContext;
}) {
  const who = reply.senderId ? (people[reply.senderId]?.name ?? "Someone") : "Someone";
  return (
    <div className="mb-0.5 ml-12 flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
      <CornerUpLeft className="h-3 w-3 shrink-0 -scale-x-100" />
      {reply.deleted || !reply.preview ? (
        <span className="italic">Original message was deleted</span>
      ) : (
        <>
          <span className="shrink-0 font-semibold text-ink-soft">@{who}</span>
          <span className="truncate">
            {plainText(reply.preview, (id) => people[id]?.name, (id) => markup.channelName(id), 120)}
          </span>
        </>
      )}
    </div>
  );
}

function Attachments({ m }: { m: UiMessage }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {m.attachments.map((a, i) => {
        // While sending, the file isn't readable through the route yet.
        if (m.pending || m.failed) {
          return (
            <span key={a.path} className="inline-flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-soft">
              <FileText className="h-4 w-4" />
              {a.name}
            </span>
          );
        }
        if (isInlineImage(a)) {
          return (
            <a key={a.path} href={chatFileHref(m.id, i)} target="_blank" rel="noopener noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={chatFileHref(m.id, i)}
                alt={a.name}
                loading="lazy"
                className="max-h-72 max-w-[min(100%,28rem)] rounded-md border border-line object-contain"
              />
            </a>
          );
        }
        const kind = attachmentKind({ contentType: a.type, fileName: a.name });
        const Icon = kind === "video" ? Video : FileText;
        return (
          <a
            key={a.path}
            href={chatFileHref(m.id, i, { download: true })}
            className="inline-flex max-w-full items-center gap-2.5 rounded-md border border-line bg-paper px-3 py-2 text-sm hover:border-ink/30"
          >
            <Icon className="h-5 w-5 shrink-0 text-ink-faint" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink">{a.name}</span>
              <span className="block font-mono text-[11px] text-ink-faint">{formatBytes(a.size)}</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

function EditBox({
  m,
  people,
  onCancel,
  onSave,
}: {
  m: UiMessage;
  people: Record<string, ChatPerson>;
  onCancel: () => void;
  onSave: (body: string) => Promise<string | null>;
}) {
  const decoded = useMemo(() => decodeMentions(m.body, (id) => people[id]?.name), [m.body, people]);
  const [text, setText] = useState(decoded.text);
  const [picked] = useState<PickedMention[]>(decoded.picked);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(await onSave(encodeMentions(text, picked)));
    setSaving(false);
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !imeComposing(e)) {
            e.preventDefault();
            void save();
          }
        }}
        rows={1}
        className="w-full resize-none rounded-md border border-line bg-paper px-3 py-2 text-[15px] text-ink focus:border-ink/40 focus:outline-none"
      />
      <p className="mt-1 text-[11px] text-ink-faint">
        Escape to <button type="button" className="link-ink" onClick={onCancel}>cancel</button> · Enter to{" "}
        <button type="button" className="link-ink" onClick={() => void save()}>save</button>
        {saving ? " · saving…" : ""}
      </p>
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
