"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Archive,
  Bell,
  BellOff,
  Ban,
  Flag,
  Hash,
  Loader2,
  Lock,
  Megaphone,
  Pencil,
  Pin,
  Search,
  Settings2,
  UserPlus,
  Users,
  LogOut,
  X,
  ShieldAlert,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { typingLine } from "@/lib/chat-view";
import { blockPerson, closeConversation, fetchMembers, leaveGroup, setNotify, unblockPerson } from "@/app/chat/actions";
import { setChannelArchived } from "@/app/chat/manage-actions";
import { Avatar } from "./avatar";
import { MessageList, type MessageActions } from "./message-list";
import { Composer } from "./composer";
import { MenuItem, Popover } from "./popover";
import { AddPeopleDialog, ChannelSettingsDialog, RenameGroupDialog, ReportDialog } from "./dialogs";
import type { MarkupContext } from "./markup";
import { resultError } from "./util";
import type { ChannelPayload, ChatPerson, ChatViewerInfo, Panel, UiMessage } from "./types";

export function ChannelView({
  viewer,
  payload,
  messages,
  people,
  online,
  channelNames,
  loading,
  error,
  onDismissError,
  typingIds,
  onTyping,
  hasMoreBefore,
  loadingOlder,
  onLoadOlder,
  hasMoreAfter,
  onJumpToPresent,
  jumpTo,
  onJumped,
  onBack,
  panel,
  onPanel,
  onSend,
  onRetry,
  onDiscard,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onOpenChannel,
  onMessagePerson,
  onNearBottom,
  onChannelChanged,
  onLeft,
  blocked,
  onBlocksChanged,
}: {
  viewer: ChatViewerInfo;
  payload: ChannelPayload | null;
  messages: UiMessage[];
  people: Record<string, ChatPerson>;
  online: Set<string>;
  channelNames: Map<string, string>;
  loading: boolean;
  error: string | null;
  onDismissError: () => void;
  typingIds: string[];
  onTyping: () => void;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  hasMoreAfter: boolean;
  onJumpToPresent: () => void;
  jumpTo: string | null;
  onJumped: () => void;
  onBack: () => void;
  panel: Panel;
  onPanel: (p: Exclude<Panel, null>) => void;
  onSend: (input: { body: string; replyTo: UiMessage | null; attachments: { path: string; name: string; size: number; type: string }[] }) => void;
  onRetry: (m: UiMessage) => void;
  onDiscard: (id: string) => void;
  onEdit: (id: string, body: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  onReact: (id: string, emoji: string) => void;
  onPin: (id: string) => void;
  onOpenChannel: (id: string) => void;
  onMessagePerson: (userId: string) => void;
  onNearBottom: (near: boolean) => void;
  onChannelChanged: () => void;
  onLeft: () => void;
  blocked: readonly string[];
  onBlocksChanged: () => void;
}) {
  const channel = payload?.channel ?? null;
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UiMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [report, setReport] = useState<{ message: UiMessage | null } | null>(null);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"settings" | "rename" | "add" | "leave" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [members, setMembers] = useState<ChatPerson[]>([]);
  const membersFor = useRef<string | null>(null);

  // Reset per-channel UI on switch. A draft's first message turns it into
  // the DM with that person: same conversation, so it keeps the draft's key
  // — the composer holds on to whatever was typed while the DM was created.
  const rawKey = channel?.id ?? (payload?.draftTo ? `draft:${payload.draftTo.id}` : "none");
  const aliases = useRef(new Map<string, string>());
  const lastKey = useRef(rawKey);
  if (channel?.kind === "dm" && channel.otherId && lastKey.current === `draft:${channel.otherId}`) {
    aliases.current.set(channel.id, lastKey.current);
  }
  const key = (channel && aliases.current.get(channel.id)) ?? rawKey;
  lastKey.current = key;
  useEffect(() => {
    setReplyTo(null);
    setEditingId(null);
    setMenu(false);
    setNotice(null);
  }, [key]);

  // Who the "@" menu can offer: everyone who can read the channel.
  useEffect(() => {
    if (!channel) {
      setMembers(payload?.draftTo ? [payload.draftTo] : []);
      return;
    }
    const key = `${channel.id}:${channel.memberIds.length}`;
    if (membersFor.current === key) return;
    membersFor.current = key;
    setMembers(Object.values(people).filter((p) => channel.memberIds.includes(p.id)));
    fetchMembers(channel.id)
      .then((list) => {
        if (membersFor.current === key) setMembers(list);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id, channel?.memberIds.length, payload?.draftTo]);

  const markup: MarkupContext = useMemo(
    () => ({
      viewerId: viewer.id,
      personName: (id) => people[id]?.name ?? members.find((m) => m.id === id)?.name ?? null,
      channelName: (id) => channelNames.get(id) ?? null,
      onMention: (id) => onMessagePerson(id),
      onChannel: (id) => onOpenChannel(id),
    }),
    [viewer.id, people, members, channelNames, onMessagePerson, onOpenChannel],
  );

  const toggleBlock = useCallback(
    async (userId: string) => {
      const isBlocked = blocked.includes(userId);
      const res = isBlocked ? await unblockPerson(userId) : await blockPerson(userId);
      if (!res.ok) {
        setNotice(resultError(res, "Couldn't do that."));
        return;
      }
      setNotice(isBlocked ? "Unblocked." : "Blocked. They aren't told.");
      onBlocksChanged();
      if (channel?.kind === "dm") onChannelChanged();
    },
    [blocked, channel?.kind, onBlocksChanged, onChannelChanged],
  );

  const actions: MessageActions = {
    onReply: (m) => setReplyTo(m),
    onEdit,
    onDelete: (m) => setConfirmDelete(m),
    onReact,
    onPin,
    onReport: (m) => setReport({ message: m }),
    onBlock: (id) => void toggleBlock(id),
    onRetry,
    onDiscard,
    onMessagePerson,
  };

  const editLast = () => {
    const mine = [...messages].reverse().find((m) => m.senderId === viewer.id && !m.pending && !m.failed && m.kind === "message");
    if (mine && channel && !channel.archived) setEditingId(mine.id);
  };

  const candidates = useMemo(() => members.filter((m) => m.id !== viewer.id), [members, viewer.id]);
  const typingNames = typingIds.map((id) => people[id]?.name ?? members.find((m) => m.id === id)?.name ?? "Someone");

  if (!payload) {
    return (
      <div className="flex h-full flex-col">
        <MobileBar onBack={onBack} title="Chat" />
        <div className="flex flex-1 items-center justify-center p-8">
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin text-ink-faint" />
          ) : (
            <div className="max-w-sm text-center">
              <p className="font-display text-3xl text-ink">{error ? "Not available" : "Pick a conversation"}</p>
              <p className="mt-2 text-sm text-ink-soft">
                {error ?? "Choose a channel or a direct message on the left, or start a new one."}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const label = channel?.label ?? payload.draftTo?.name ?? "";
  const Icon = channel?.kind === "channel" ? (channel.posting === "staff" ? Megaphone : channel.audience === "everyone" || channel.audience === "cohort" ? Hash : Lock) : null;
  const compose = channel ? channel.compose : (payload.draftCompose ?? { ok: true as const });
  const placeholder =
    channel?.kind === "channel" ? `Message #${label}` : `Message ${label}`;
  const otherId = channel?.kind === "dm" ? channel.otherId : (payload.draftTo?.id ?? null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5 pt-[calc(0.625rem+var(--safe-top))] md:px-5 md:pt-2.5">
        <button type="button" onClick={onBack} aria-label="Back to conversations" className="rounded-md p-1.5 text-ink-soft hover:bg-wash md:hidden">
          <ArrowLeft className="h-5 w-5" />
        </button>
        {Icon ? (
          <Icon className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
        ) : channel?.kind === "group" ? (
          <Users className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
        ) : (
          <Avatar name={label} online={!!otherId && online.has(otherId)} size={28} />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold text-ink">{label}</h1>
          {channel?.topic ? (
            <p className="truncate text-xs text-ink-faint">{channel.topic}</p>
          ) : channel?.kind === "group" ? (
            <p className="truncate text-xs text-ink-faint">{channel.memberIds.length} members</p>
          ) : otherId ? (
            <p className="truncate text-xs text-ink-faint">{online.has(otherId) ? "Online" : "Offline"}</p>
          ) : null}
        </div>
        {channel ? (
          <div className="flex shrink-0 items-center">
            <HeaderButton label="Search" active={panel === "search"} onClick={() => onPanel("search")}>
              <Search className="h-4 w-4" />
            </HeaderButton>
            <HeaderButton label={`Pinned messages${payload.pins ? ` (${payload.pins})` : ""}`} active={panel === "pins"} onClick={() => onPanel("pins")}>
              <Pin className="h-4 w-4" />
            </HeaderButton>
            {channel.kind !== "dm" ? (
              <HeaderButton label="Members" active={panel === "members"} onClick={() => onPanel("members")}>
                <Users className="h-4 w-4" />
              </HeaderButton>
            ) : null}
            <div className="relative">
              <HeaderButton label="Channel options" active={menu} onClick={() => setMenu((m) => !m)}>
                {channel.notify === "none" ? <BellOff className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
              </HeaderButton>
              <Popover open={menu} onClose={() => setMenu(false)} className="right-0 top-10 w-60">
                <div role="menu">
                  {!channel.moderatorView ? (
                    <>
                      <p className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Notifications</p>
                      {(
                        [
                          ["all", "All messages"],
                          ["mentions", "Only @mentions"],
                          ["none", "Nothing (mute)"],
                        ] as const
                      ).map(([v, l]) => (
                        <MenuItem
                          key={v}
                          icon={v === "none" ? BellOff : Bell}
                          onClick={async () => {
                            setMenu(false);
                            const res = await setNotify(channel.id, v);
                            setNotice(res.ok ? `Notifications: ${l.toLowerCase()}.` : resultError(res, "Couldn't save that."));
                            onChannelChanged();
                          }}
                        >
                          {l}
                          {channel.notify === v ? " ✓" : ""}
                        </MenuItem>
                      ))}
                      <div className="my-1 h-px bg-line" />
                    </>
                  ) : null}
                  {channel.kind === "channel" && channel.canManage ? (
                    <>
                      <MenuItem icon={Pencil} onClick={() => { setMenu(false); setDialog("settings"); }}>Edit channel</MenuItem>
                      <MenuItem icon={UserPlus} onClick={() => { setMenu(false); setDialog("add"); }}>Add people</MenuItem>
                      <MenuItem
                        icon={Archive}
                        onClick={async () => {
                          setMenu(false);
                          const res = await setChannelArchived(channel.id, !channel.archived);
                          setNotice(res.ok ? (channel.archived ? "Channel restored." : "Channel archived: read-only for everyone.") : resultError(res, "Couldn't do that."));
                          onChannelChanged();
                        }}
                      >
                        {channel.archived ? "Unarchive" : "Archive channel"}
                      </MenuItem>
                    </>
                  ) : null}
                  {channel.kind === "group" && !channel.moderatorView ? (
                    <>
                      <MenuItem icon={Pencil} onClick={() => { setMenu(false); setDialog("rename"); }}>Rename group</MenuItem>
                      <MenuItem icon={UserPlus} onClick={() => { setMenu(false); setDialog("add"); }}>Add people</MenuItem>
                      <MenuItem icon={Flag} danger onClick={() => { setMenu(false); setReport({ message: null }); }}>Report conversation</MenuItem>
                      <MenuItem icon={LogOut} danger onClick={() => { setMenu(false); setDialog("leave"); }}>Leave group</MenuItem>
                    </>
                  ) : null}
                  {channel.kind === "dm" && !channel.moderatorView ? (
                    <>
                      {otherId ? (
                        <MenuItem icon={Ban} danger onClick={() => { setMenu(false); void toggleBlock(otherId); }}>
                          {channel.blockedByYou ? "Unblock" : "Block"} {label.split(" ")[0]}
                        </MenuItem>
                      ) : null}
                      <MenuItem icon={Flag} danger onClick={() => { setMenu(false); setReport({ message: null }); }}>Report conversation</MenuItem>
                      <MenuItem
                        icon={X}
                        onClick={async () => {
                          setMenu(false);
                          await closeConversation(channel.id).catch(() => undefined);
                          onLeft();
                        }}
                      >
                        Close conversation
                      </MenuItem>
                    </>
                  ) : null}
                </div>
              </Popover>
            </div>
          </div>
        ) : null}
      </header>

      {channel?.moderatorView ? (
        <Banner icon={ShieldAlert}>
          You&apos;re reading a reported conversation as a moderator. You can&apos;t post in it. Work the report from Admin → Chat.
        </Banner>
      ) : null}
      {channel?.archived ? <Banner icon={Archive}>This channel is archived. It&apos;s read-only now.</Banner> : null}
      {error ? (
        <Banner icon={X} onDismiss={onDismissError} tone="error">
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner icon={Bell} onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}

      <MessageList
        viewer={viewer}
        channel={channel}
        messages={messages}
        people={people}
        online={online}
        blocked={blocked}
        cursor={payload.cursor}
        markup={markup}
        hasMoreBefore={hasMoreBefore}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
        hasMoreAfter={hasMoreAfter}
        onJumpToPresent={onJumpToPresent}
        jumpTo={jumpTo}
        onJumped={onJumped}
        editingId={editingId}
        setEditingId={setEditingId}
        actions={actions}
        onNearBottom={onNearBottom}
        emptyHint={<Intro payload={payload} label={label} />}
      />

      <div className="h-5 shrink-0 px-4 text-xs text-ink-faint md:px-6" aria-live="polite">
        {typingNames.length ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex gap-0.5" aria-hidden>
              <span className="h-1 w-1 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.2s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.1s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-ink-faint" />
            </span>
            {typingLine(typingNames)}
          </span>
        ) : null}
      </div>

      {channel?.moderatorView ? null : (
        <Composer
          channelId={channel?.id ?? null}
          placeholder={placeholder}
          disabledReason={compose.ok ? null : compose.reason}
          slowmodeWait={channel?.slowmodeWait ?? 0}
          slowmodeSeconds={channel && channel.kind === "channel" && !viewer.staff ? channel.slowmodeSeconds : 0}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          people={people}
          candidates={candidates}
          onSend={onSend}
          onTyping={onTyping}
          onEditLast={editLast}
          canMentionEveryone={!!channel?.canMentionEveryone}
          draftKey={key}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete?.senderId === viewer.id ? "Delete this message?" : "Remove this message?"}
        description={
          confirmDelete?.senderId === viewer.id
            ? "It disappears for everyone. The batch0 team can still see what it said if it's ever reported."
            : "It disappears for everyone, and the removal is logged."
        }
        confirmLabel={confirmDelete?.senderId === viewer.id ? "Delete" : "Remove"}
        destructive
        pending={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          setDeleting(true);
          const err = await onDelete(confirmDelete.id);
          setDeleting(false);
          setConfirmDelete(null);
          if (err) setNotice(err);
        }}
      />

      {report && channel ? (
        <ReportDialog
          channel={channel}
          message={report.message}
          people={people}
          onClose={() => setReport(null)}
          onDone={() => {
            setReport(null);
            setNotice("Reported. The batch0 team will look at it. Nobody else is told who reported.");
          }}
        />
      ) : null}

      {dialog === "settings" && channel ? (
        <ChannelSettingsDialog
          channel={channel}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setNotice("Channel saved.");
            onChannelChanged();
          }}
        />
      ) : null}
      {dialog === "rename" && channel ? (
        <RenameGroupDialog
          channel={channel}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onChannelChanged();
          }}
        />
      ) : null}
      {dialog === "add" && channel ? (
        <AddPeopleDialog
          channel={channel}
          onClose={() => setDialog(null)}
          onSaved={(n) => {
            setDialog(null);
            setNotice(`Added ${n === 1 ? "1 person" : `${n} people`}.`);
            membersFor.current = null;
            onChannelChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={dialog === "leave"}
        title="Leave this group?"
        description="You won't see new messages. Someone in it can add you back."
        confirmLabel="Leave"
        destructive
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          if (!channel) return;
          const res = await leaveGroup(channel.id);
          setDialog(null);
          if (!res.ok) setNotice(resultError(res, "Couldn't leave the group."));
          else onLeft();
        }}
      />
    </div>
  );
}

function Intro({ payload, label }: { payload: ChannelPayload; label: string }) {
  const c = payload.channel;
  if (!c) {
    return (
      <div>
        <p className="font-display text-3xl text-ink">{label}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {payload.draftCompose && !payload.draftCompose.ok
            ? `You can't start a private conversation with ${label}.`
            : `This is the start of your conversation with ${label}. Say hi.`}
        </p>
      </div>
    );
  }
  if (c.kind === "channel") {
    return (
      <div>
        <p className="font-display text-3xl text-ink">Welcome to #{label}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {c.topic ?? "This is the start of the channel."}
          {c.posting === "staff" ? " Only the batch0 team posts here; you can react." : ""}
          {c.slowmodeSeconds ? ` Slow mode is on: one message every ${c.slowmodeSeconds}s.` : ""}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="font-display text-3xl text-ink">{label}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {c.kind === "group" ? "This is the start of the group." : `This is the start of your conversation with ${label}.`} Only the people in it can read it — unless someone in it reports it to the batch0 team.
      </p>
    </div>
  );
}

function HeaderButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md ${active ? "bg-wash text-ink" : "text-ink-soft hover:bg-wash hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

function Banner({
  icon: Icon,
  children,
  onDismiss,
  tone = "info",
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onDismiss?: () => void;
  tone?: "info" | "error";
}) {
  return (
    <div
      className={`flex shrink-0 items-start gap-2 border-b px-4 py-2 text-xs md:px-6 ${
        tone === "error" ? "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300" : "border-line bg-wash text-ink-soft"
      }`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded hover:bg-paper">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function MobileBar({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 pt-[calc(0.625rem+var(--safe-top))] md:hidden">
      <button type="button" onClick={onBack} aria-label="Back to conversations" className="rounded-md p-1.5 text-ink-soft hover:bg-wash">
        <ArrowLeft className="h-5 w-5" />
      </button>
      <span className="text-sm font-semibold text-ink">{title}</span>
    </div>
  );
}
