"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, CheckCheck, Hash, Lock, Megaphone, Plus, Search, Settings2, Users, X } from "lucide-react";
import { badgeText } from "@/lib/chat-access";
import { closeConversation } from "@/app/chat/actions";
import { Avatar } from "./avatar";
import { BlockedPeopleDialog } from "./dialogs";
import type { ChatPerson, ChatViewerInfo, SidebarData, SidebarItem } from "./types";

/** The left rail: who you are, text channels, then DMs and groups. */
export function ChatSidebar({
  viewer,
  home,
  homeLabel,
  sidebar,
  people,
  online,
  activeId,
  draftTo,
  onOpen,
  onNew,
  onSwitcher,
  onMarkAllRead,
  onChanged,
}: {
  viewer: ChatViewerInfo;
  home: string;
  homeLabel: string;
  sidebar: SidebarData;
  people: Record<string, ChatPerson>;
  online: Set<string>;
  activeId: string | null;
  draftTo: ChatPerson | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSwitcher: () => void;
  onMarkAllRead: () => void;
  onChanged: () => void;
}) {
  const [blockedOpen, setBlockedOpen] = useState(false);
  const anyUnread = [...sidebar.channels, ...sidebar.conversations].some((i) => i.unread > 0);
  const me = people[viewer.id];

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <Link
          href={home}
          className="inline-flex min-w-0 items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          prefetch={false}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">{homeLabel}</span>
        </Link>
        <span className="font-display text-2xl leading-none text-ink">chat</span>
      </div>

      <div className="flex shrink-0 gap-2 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={onSwitcher}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-wash px-2.5 text-left text-sm text-ink-faint hover:border-ink/30"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="truncate">Find a conversation</span>
          <kbd className="ml-auto hidden rounded border border-line px-1 font-mono text-[10px] md:inline">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={onNew}
          aria-label="New message"
          title="New message"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-phosphor text-on-phosphor hover:bg-phosphor-200"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sidebar.channels.length > 0 ? (
          <Section
            title="Channels"
            action={
              anyUnread ? (
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink"
                  title="Mark everything read"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Mark read
                </button>
              ) : null
            }
          >
            {sidebar.channels.map((c) => (
              <ChannelRow key={c.id} item={c} active={c.id === activeId} onOpen={onOpen} />
            ))}
          </Section>
        ) : !viewer.vetted ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-ink-faint">
            Channels open once you&apos;ve been accepted. Until then you can message the batch0 team with the + button.
          </p>
        ) : null}

        <Section title="Direct messages">
          {draftTo ? (
            <PersonRow
              label={draftTo.name}
              preview="New message"
              online={online.has(draftTo.id)}
              active
              unread={0}
              onClick={() => undefined}
            />
          ) : null}
          {sidebar.conversations.length === 0 && !draftTo ? (
            <button
              type="button"
              onClick={onNew}
              className="w-full rounded-md px-2 py-2 text-left text-xs text-ink-faint hover:bg-wash hover:text-ink"
            >
              No conversations yet. Start one →
            </button>
          ) : null}
          {sidebar.conversations.map((c) => (
            <ConversationRow
              key={c.id}
              item={c}
              people={people}
              online={online}
              active={c.id === activeId}
              onOpen={onOpen}
              onClosed={onChanged}
            />
          ))}
        </Section>
      </nav>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-line px-3 py-2.5 pb-[calc(0.625rem+var(--safe-bottom))]">
        <Avatar name={me?.name ?? viewer.name} online size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{me?.name ?? viewer.name}</p>
          <p className="truncate text-[11px] text-ink-faint">{viewer.staff ? "Runs chat" : "Online"}</p>
        </div>
        {viewer.staff ? (
          <Link
            href="/admin/chat"
            prefetch={false}
            title="Manage channels and reports"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-faint hover:bg-wash hover:text-ink"
          >
            <Settings2 className="h-4 w-4" />
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => setBlockedOpen(true)}
          className="rounded-md px-2 py-1 text-[11px] text-ink-faint hover:bg-wash hover:text-ink"
        >
          Blocked
        </button>
      </div>
      <BlockedPeopleDialog open={blockedOpen} onClose={() => setBlockedOpen(false)} />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">{title}</h2>
        {action}
      </div>
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

function channelIcon(item: Pick<SidebarItem, "posting" | "audience">) {
  if (item.posting === "staff") return Megaphone;
  if (item.audience === "staff" || item.audience === "members" || item.audience === "team") return Lock;
  return Hash;
}

function ChannelRow({ item, active, onOpen }: { item: SidebarItem; active: boolean; onOpen: (id: string) => void }) {
  const Icon = channelIcon(item);
  const muted = item.notify === "none";
  const bold = item.unread > 0 && !muted;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        aria-current={active ? "page" : undefined}
        className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
          active ? "bg-wash text-ink" : bold ? "text-ink hover:bg-wash" : "text-ink-soft hover:bg-wash hover:text-ink"
        } ${muted ? "opacity-60" : ""}`}
      >
        <Icon className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
        <span className={`min-w-0 flex-1 truncate ${bold ? "font-semibold" : ""}`}>{item.label}</span>
        {item.mentions > 0 && !muted ? <Badge n={item.mentions} /> : bold ? <span className="h-1.5 w-1.5 rounded-full bg-ink" aria-label="Unread" /> : null}
      </button>
    </li>
  );
}

function ConversationRow({
  item,
  people,
  online,
  active,
  onOpen,
  onClosed,
}: {
  item: SidebarItem;
  people: Record<string, ChatPerson>;
  online: Set<string>;
  active: boolean;
  onOpen: (id: string) => void;
  onClosed: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const isGroup = item.kind === "group";
  return (
    <PersonRow
      label={item.label}
      preview={item.preview}
      online={!isGroup && !!item.otherId && online.has(item.otherId)}
      group={isGroup ? item.memberIds.length : 0}
      active={active}
      unread={item.notify === "none" ? 0 : item.unread}
      onClick={() => onOpen(item.id)}
      onClose={
        closing
          ? undefined
          : async () => {
              setClosing(true);
              await closeConversation(item.id).catch(() => undefined);
              setClosing(false);
              onClosed();
            }
      }
      personName={item.otherId ? people[item.otherId]?.name : undefined}
    />
  );
}

function PersonRow({
  label,
  preview,
  online,
  group = 0,
  active,
  unread,
  onClick,
  onClose,
  personName,
}: {
  label: string;
  preview: string | null;
  online: boolean;
  group?: number;
  active: boolean;
  unread: number;
  onClick: () => void;
  onClose?: () => void;
  personName?: string;
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 pr-8 text-left ${
          active ? "bg-wash" : "hover:bg-wash"
        }`}
      >
        {group ? (
          <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-wash text-ink-faint">
            <Users className="h-4 w-4" />
          </span>
        ) : (
          <Avatar name={personName ?? label} online={online} size={32} />
        )}
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${unread > 0 ? "font-semibold text-ink" : "text-ink-soft"}`}>{label}</span>
          {preview ? <span className="block truncate text-[11px] text-ink-faint">{preview}</span> : null}
        </span>
        {unread > 0 ? <Badge n={unread} /> : null}
      </button>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close conversation with ${label}`}
          title="Close (it comes back when there's a new message)"
          className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-faint hover:bg-paper hover:text-ink group-hover:inline-flex group-focus-within:inline-flex"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </li>
  );
}

function Badge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-phosphor px-1.5 font-mono text-[10px] font-semibold text-on-phosphor">
      {badgeText(n)}
    </span>
  );
}
