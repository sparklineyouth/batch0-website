import { compareConversations, countsAsMessage, sidebarMentions } from "../../lib/chat-access.ts";
import { cutBody, plainText } from "../../lib/chat-format.ts";
import { mentionsViewer } from "../../lib/chat-view.ts";
import type { ChatAttachment } from "@/lib/chat-files-rules";
import type { LiveRow } from "./use-chat-live";
import type { SidebarData, SidebarItem, UiMessage } from "./types";

// ---------------------------------------------------------------------------
// batch0 Chat — what the client does with a Realtime row, as pure functions:
// turning an INSERT into a message, applying an UPDATE (an edit, a reaction,
// a pin, a delete) to a list, telling a fresh copy that changes nothing from
// one that does, and patching the sidebar row of the conversation it landed
// in. Relative imports, so `node --test` runs the test beside this file as-is.
// ---------------------------------------------------------------------------

type Reply = NonNullable<UiMessage["replyTo"]>;

/** Still on this screen only: sending, or failed with Retry. */
export const localOnly = (m: UiMessage) => !!m.pending || !!m.failed;

/** What a quote of this message shows: its words (cut as the server cuts them), or that it was a file. */
export function quotePreview(m: { body: string; attachments: readonly unknown[] }): string {
  return m.body ? cutBody(m.body, 300) : m.attachments.length ? "[attachment]" : "";
}

export function toQuote(m: UiMessage): Reply {
  return { id: m.id, senderId: m.senderId, preview: quotePreview(m), deleted: false };
}

/** A Realtime INSERT as a message. `known` is what's loaded, for the reply's quote. */
export function toUiMessage(row: LiveRow, known: readonly UiMessage[]): UiMessage {
  const reply = row.reply_to_id ? known.find((m) => m.id === row.reply_to_id) : null;
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    body: row.body ?? "",
    kind: row.kind ?? "message",
    // An original that isn't loaded is filled in by hydrate; until then the
    // quote says "Replying to a message", not that it was deleted.
    replyTo: row.reply_to_id
      ? reply
        ? toQuote(reply)
        : { id: row.reply_to_id, senderId: null, preview: "", deleted: false }
      : null,
    mentions: row.mentions ?? [],
    mentionEveryone: !!row.mention_everyone,
    attachments: (Array.isArray(row.attachments) ? row.attachments : []) as ChatAttachment[],
    reactions: row.reactions ?? {},
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    pinnedAt: row.pinned_at ?? null,
  };
}

export const has = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/**
 * Apply a Realtime UPDATE to a list. A column the change record leaves out
 * (Postgres doesn't log an unchanged TOASTed body, so a reaction or a pin on
 * a long message arrives without one) is unchanged — never blank, never a
 * crash.
 */
export function applyUpdate(list: UiMessage[], row: LiveRow): UiMessage[] {
  if (row.deleted_at) return withoutMessage(list, row.id);
  const body = has(row, "body") && typeof row.body === "string" ? row.body : null;
  let out = list;
  const i = list.findIndex((m) => m.id === row.id);
  if (i !== -1) {
    const cur = list[i];
    out = [...list];
    out[i] = {
      ...cur,
      body: body ?? cur.body,
      editedAt: has(row, "edited_at") ? (row.edited_at ?? null) : cur.editedAt,
      mentions: has(row, "mentions") ? (row.mentions ?? []) : cur.mentions,
      mentionEveryone: has(row, "mention_everyone") ? !!row.mention_everyone : cur.mentionEveryone,
      reactions: has(row, "reactions") ? (row.reactions ?? {}) : cur.reactions,
      pinnedAt: has(row, "pinned_at") ? (row.pinned_at ?? null) : cur.pinnedAt,
      attachments: has(row, "attachments") && Array.isArray(row.attachments) ? (row.attachments as ChatAttachment[]) : cur.attachments,
    };
  }
  // A reply quoting this message follows its edits, whether or not the
  // original itself is loaded.
  if (body !== null) {
    const attachments = i !== -1 ? out[i].attachments : has(row, "attachments") && Array.isArray(row.attachments) ? row.attachments : [];
    const preview = quotePreview({ body, attachments });
    if (out.some((m) => m.replyTo?.id === row.id && !m.replyTo.deleted && m.replyTo.preview !== preview)) {
      out = out.map((m) =>
        m.replyTo?.id === row.id && !m.replyTo.deleted ? { ...m, replyTo: { ...m.replyTo, preview } } : m,
      );
    }
  }
  return out;
}

/** Drop a deleted message, and blank every reply quote that carried its words. */
export function withoutMessage(list: UiMessage[], id: string): UiMessage[] {
  const quoted = list.some((m) => m.replyTo?.id === id && !m.replyTo.deleted);
  if (!quoted && !list.some((m) => m.id === id)) return list;
  return list
    .filter((m) => m.id !== id)
    .map((m) => (m.replyTo?.id === id ? { ...m, replyTo: { ...m.replyTo, preview: "", deleted: true } } : m));
}

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Same message, same state: a fresh copy from the server that changes nothing on screen. */
export function sameMessage(a: UiMessage, b: UiMessage): boolean {
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.editedAt === b.editedAt &&
    a.pinnedAt === b.pinnedAt &&
    a.createdAt === b.createdAt &&
    a.senderId === b.senderId &&
    a.kind === b.kind &&
    a.mentionEveryone === b.mentionEveryone &&
    !localOnly(a) &&
    !localOnly(b) &&
    sameJson(a.mentions, b.mentions) &&
    sameJson(a.reactions, b.reactions) &&
    sameJson(a.attachments, b.attachments) &&
    sameJson(a.replyTo, b.replyTo)
  );
}

/**
 * A live INSERT in the open conversation, on the sidebar: its row's recency,
 * a DM's or group's preview, and — unless the reader is looking at it right
 * now — its unread and the number on it. What counts mirrors the server's
 * chat_unread: a message (or a #staff feed line, countsAsMessage) from
 * someone else who isn't blocked; the number is sidebarMentions' (a
 * channel's mentions; a conversation's unread, or its mentions on "Only
 * @mentions").
 *
 * Decided here, synchronously, from the sidebar as it is: `missing` (the
 * conversation isn't in the sidebar at all — a closed DM coming back, one
 * never seen) is the only reason a live message refetches the sidebar. Every
 * other row comes from the poll. An unknown row returns the same sidebar.
 */
export function bumpSidebarRow(
  s: SidebarData,
  row: LiveRow,
  opts: { viewerId: string; reading: boolean; personName: (id: string) => string | null | undefined },
): { sidebar: SidebarData; missing: boolean } {
  const known = (i: SidebarItem) => i.id === row.channel_id;
  const item = s.channels.find(known) ?? s.conversations.find(known);
  if (!item) return { sidebar: s, missing: true };
  const message = countsAsMessage(row.kind ?? "message", item.systemKey);
  const fromOther = row.sender_id !== opts.viewerId;
  const fromBlocked = !!row.sender_id && s.blocked.includes(row.sender_id);
  const counts = message && fromOther && !fromBlocked && !opts.reading;
  const isConversation = item.kind !== "channel";
  const mention = mentionsViewer(
    { mentions: row.mentions ?? [], mentionEveryone: !!row.mention_everyone, senderId: row.sender_id },
    opts.viewerId,
  );
  const next: SidebarItem = {
    ...item,
    lastMessageAt: message ? row.created_at : item.lastMessageAt,
    preview:
      isConversation && message ? plainText(row.body || "[attachment]", opts.personName, () => null, 80) : item.preview,
    unread: counts ? Math.min(item.unread + 1, 100) : item.unread,
    mentions: counts
      ? Math.min(item.mentions + sidebarMentions(item.kind, { unread: 1, mentions: mention ? 1 : 0 }, item.notify), 100)
      : item.mentions,
  };
  const swap = (items: SidebarItem[]) => items.map((i) => (i === item ? next : i));
  const sidebar = isConversation
    ? {
        ...s,
        conversations: swap(s.conversations).sort((a, b) =>
          compareConversations({ ...a, name: a.label }, { ...b, name: b.label }),
        ),
      }
    : { ...s, channels: swap(s.channels) };
  return { sidebar, missing: false };
}
