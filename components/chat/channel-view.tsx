"use client";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { blockPerson, closeConversation, leaveGroup, setNotify, unblockPerson } from "@/app/chat/actions";
import { setChannelArchived } from "@/app/chat/manage-actions";
import { Avatar } from "./avatar";
import { MessageList, type MessageActions } from "./message-list";
import { Composer } from "./composer";
import { MenuItem, MenuSeparator, Popover } from "./popover";
import {
  AddPeopleDialog,
  ChannelSettingsDialog,
  FlagDialog,
  MuteDialog,
  RenameGroupDialog,
  ReportDeletedDialog,
  ReportDialog,
} from "./dialogs";
import type { MarkupContext } from "./markup";
import { chatApi, NOT_AVAILABLE, tracked } from "./api";
import { OFFLINE, resultError } from "./util";
import type { ActionResult } from "@/lib/action-result";
import type { ChannelPayload, ChatPerson, ChatViewerInfo, Panel, UiMessage } from "./types";

export function ChannelView({
  viewer,
  payload,
  messages,
  people,
  online,
  channelNames,
  loading,
  opening,
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
  wasDeleted,
  onPeople,
}: {
  viewer: ChatViewerInfo;
  payload: ChannelPayload | null;
  messages: UiMessage[];
  people: Record<string, ChatPerson>;
  online: Set<string>;
  channelNames: Map<string, string>;
  loading: boolean;
  /** The name of the conversation being opened, while it loads. */
  opening: string | null;
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
  /** Settings, notifications, members or a block changed for this channel: refetch it. */
  onChannelChanged: (channelId: string) => void;
  /** Closed or left: drop it. */
  onLeft: (channelId: string) => void;
  blocked: readonly string[];
  onBlocksChanged: () => void;
  /** Was this message deleted while the page has been open? */
  wasDeleted: (id: string) => boolean;
  /** People the client learned of here (the composer's server search): names for every message. */
  onPeople: (more: Record<string, ChatPerson>) => void;
}) {
  const channel = payload?.channel ?? null;
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UiMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [report, setReport] = useState<{ message: UiMessage | null } | null>(null);
  /** "Report a deleted message" (text channels): from the menu, or from a reply's quote of one. */
  const [reportDeleted, setReportDeleted] = useState<{ preselect: { id: string; senderId: string } | null } | null>(null);
  const [flagging, setFlagging] = useState<UiMessage | null>(null);
  const [muting, setMuting] = useState<{ userId: string; name: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"settings" | "rename" | "add" | "leave" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [members, setMembers] = useState<ChatPerson[]>([]);
  const membersFor = useRef<string | null>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);
  // Which channel is on screen now, for answers that land after a switch.
  const openIdRef = useRef<string | null>(channel?.id ?? null);
  openIdRef.current = channel?.id ?? null;

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

  // The reply bar, the edit box and the delete prompt follow what they point
  // at: an edit shows its new words, a delete takes them away.
  useEffect(() => {
    if (replyTo) {
      if (wasDeleted(replyTo.id)) setReplyTo(null);
      else {
        const now = messages.find((m) => m.id === replyTo.id);
        if (now && now !== replyTo) setReplyTo(now);
      }
    }
    if (confirmDelete && wasDeleted(confirmDelete.id)) setConfirmDelete(null);
    if (editingId && wasDeleted(editingId)) setEditingId(null);
  }, [messages, replyTo, confirmDelete, editingId, wasDeleted]);

  // Who the "@" menu offers first: everyone who can read the channel (the
  // composer asks the server past that, as you type).
  useEffect(() => {
    if (!channel) {
      setMembers(payload?.draftTo ? [payload.draftTo] : []);
      return;
    }
    const k = `${channel.id}:${channel.memberIds.length}`;
    if (membersFor.current === k) return;
    membersFor.current = k;
    setMembers(Object.values(people).filter((p) => channel.memberIds.includes(p.id)));
    chatApi
      .members(channel.id)
      .then((list) => {
        if (membersFor.current === k) setMembers(list);
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

  /** A notice for this channel, unless the person has moved on by the time it's ready. */
  const noticeFor = useCallback((id: string, text: string) => {
    if (openIdRef.current === id) setNotice(text);
  }, []);

  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const toggleBlock = useCallback(
    async (userId: string) => {
      const id = openIdRef.current;
      const kind = channel?.kind;
      const isBlocked = blockedRef.current.includes(userId);
      const res = await tracked(isBlocked ? unblockPerson(userId) : blockPerson(userId)).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!res.ok) {
        if (id) noticeFor(id, resultError(res, "Couldn't do that."));
        return;
      }
      if (id) noticeFor(id, isBlocked ? "Unblocked." : "Blocked. They aren't told.");
      onBlocksChanged();
      if (id && kind === "dm") onChannelChanged(id);
    },
    [channel?.kind, noticeFor, onBlocksChanged, onChannelChanged],
  );

  // Stable, so a re-render here (typing, presence, a poll) doesn't re-render every message.
  const actions: MessageActions = useMemo(
    () => ({
      onReply: (m) => setReplyTo(m),
      onEdit,
      onDelete: (m) => setConfirmDelete(m),
      onReact,
      onPin,
      onReport: (m) => setReport({ message: m }),
      onReportDeleted: (id, senderId) => setReportDeleted({ preselect: { id, senderId } }),
      onBlock: (id) => void toggleBlock(id),
      onRetry,
      onDiscard,
      onMessagePerson,
      onFlag: (m) => setFlagging(m),
      onMute: (userId, name) => setMuting({ userId, name }),
    }),
    [onEdit, onReact, onPin, toggleBlock, onRetry, onDiscard, onMessagePerson],
  );

  /** Run a channel-menu action; its notice and refetch go to that channel, even after a switch. */
  const menuAction = (run: () => Promise<ActionResult>, done: string, failed: string) => {
    if (!channel) return;
    const id = channel.id;
    setMenu(false);
    void tracked(run())
      .catch((): ActionResult => ({ ok: false, error: OFFLINE }))
      .then((res) => {
        noticeFor(id, res.ok ? done : resultError(res, failed));
        onChannelChanged(id);
      });
  };

  /** Close a DM or group in the sidebar (a newer message brings it back). */
  const close = async (id: string) => {
    const res = await tracked(closeConversation(id)).catch((): ActionResult => ({ ok: false, error: OFFLINE }));
    if (!res.ok) noticeFor(id, resultError(res, "Couldn't close that."));
    else onLeft(id);
  };

  const editLast = () => {
    const mine = [...messages].reverse().find((m) => m.senderId === viewer.id && !m.pending && !m.failed && m.kind === "message");
    if (mine && channel && !channel.archived) setEditingId(mine.id);
  };

  const candidates = useMemo(() => members.filter((m) => m.id !== viewer.id), [members, viewer.id]);
  // A typing broadcast carries whatever id its sender put in it. In a DM or
  // group only a member's counts (ChatApp's typingAccept); in a text channel,
  // only someone this screen already knows here — a name it holds, or the
  // channel's readers list — so nobody shows up as a stranger "typing…".
  // Still a hint, not proof: a reader can claim another reader's id.
  const typingNames = typingIds.flatMap((id) => {
    const name = people[id]?.name ?? members.find((m) => m.id === id)?.name;
    return name ? [name] : [];
  });

  if (!payload) {
    // Nothing open: loading one (its name, a spinner, no composer to type
    // into the wrong conversation), why one couldn't open, or a prompt.
    return (
      <div className="flex h-full flex-col">
        <MobileBar onBack={onBack} title={opening || "Chat"} />
        {opening ? (
          <div className="hidden shrink-0 items-center gap-2 border-b border-line px-5 py-2.5 md:flex">
            <h1 className="truncate text-[15px] font-semibold text-ink">{opening}</h1>
          </div>
        ) : null}
        <div className="flex flex-1 items-center justify-center p-8" aria-busy={loading}>
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin text-ink-faint" aria-label="Loading" />
          ) : (
            <div className="max-w-sm text-center" role={error ? "alert" : undefined}>
              <p className="font-display text-3xl text-ink">
                {error ? (error === NOT_AVAILABLE ? "Not available" : "Couldn't open that") : "Pick a conversation"}
              </p>
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
  // A moderator reading a reported DM or group gets no options at all.
  const hasOptions = !!channel && (!channel.moderatorView || (channel.kind === "channel" && channel.canManage));

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
          ) : otherId && !channel?.moderatorView ? (
            <p className="truncate text-xs text-ink-faint">{online.has(otherId) ? "Online" : "Offline"}</p>
          ) : null}
        </div>
        {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ink-faint" aria-label="Loading" /> : null}
        {channel ? (
          <div className="flex shrink-0 items-center">
            <HeaderButton label="Search" panel="search" active={panel === "search"} onClick={() => onPanel("search")}>
              <Search className="h-4 w-4" />
            </HeaderButton>
            <HeaderButton label={`Pinned messages${payload.pins ? ` (${payload.pins})` : ""}`} panel="pins" active={panel === "pins"} onClick={() => onPanel("pins")}>
              <Pin className="h-4 w-4" />
            </HeaderButton>
            {channel.kind !== "dm" ? (
              <HeaderButton label="Members" panel="members" active={panel === "members"} onClick={() => onPanel("members")}>
                <Users className="h-4 w-4" />
              </HeaderButton>
            ) : null}
            {hasOptions ? (
              <div className="relative">
                <HeaderButton ref={optionsRef} label="Channel options" menu expanded={menu} onClick={() => setMenu((m) => !m)}>
                  {channel.notify === "none" ? <BellOff className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
                </HeaderButton>
                <Popover open={menu} onClose={() => setMenu(false)} toggleRef={optionsRef} className="right-0 top-10 w-60">
                  <div role="menu" aria-label="Channel options">
                    {!channel.moderatorView ? (
                      <>
                        <div role="group" aria-labelledby="chat-notify-label">
                          <p id="chat-notify-label" className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                            Notifications
                          </p>
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
                              checked={channel.notify === v}
                              onClick={() =>
                                menuAction(() => setNotify(channel.id, v), `Notifications: ${l.toLowerCase()}.`, "Couldn't save that.")
                              }
                            >
                              {l}
                            </MenuItem>
                          ))}
                        </div>
                        <MenuSeparator />
                      </>
                    ) : null}
                    {channel.kind === "channel" ? (
                      // History and search leave deleted messages out, and a
                      // text channel can't be reported whole: this is how
                      // something posted and then deleted still gets to the team.
                      <MenuItem icon={Flag} danger onClick={() => { setMenu(false); setReportDeleted({ preselect: null }); }}>
                        Report a deleted message
                      </MenuItem>
                    ) : null}
                    {channel.kind === "channel" && channel.canManage ? (
                      <>
                        <MenuItem icon={Pencil} onClick={() => { setMenu(false); setDialog("settings"); }}>Edit channel</MenuItem>
                        <MenuItem icon={UserPlus} onClick={() => { setMenu(false); setDialog("add"); }}>Add people</MenuItem>
                        <MenuItem
                          icon={Archive}
                          onClick={() =>
                            menuAction(
                              () => setChannelArchived(channel.id, !channel.archived),
                              channel.archived ? "Channel restored." : "Channel archived: read-only for everyone.",
                              "Couldn't do that.",
                            )
                          }
                        >
                          {channel.archived ? "Unarchive" : "Archive channel"}
                        </MenuItem>
                      </>
                    ) : null}
                    {channel.kind === "group" && !channel.moderatorView ? (
                      <>
                        <MenuItem icon={Pencil} onClick={() => { setMenu(false); setDialog("rename"); }}>Rename group</MenuItem>
                        <MenuItem icon={UserPlus} onClick={() => { setMenu(false); setDialog("add"); }}>Add people</MenuItem>
                        <MenuItem icon={X} onClick={() => { setMenu(false); void close(channel.id); }}>Close conversation</MenuItem>
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
                        <MenuItem icon={X} onClick={() => { setMenu(false); void close(channel.id); }}>
                          Close conversation
                        </MenuItem>
                      </>
                    ) : null}
                  </div>
                </Popover>
              </div>
            ) : null}
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
          selfId={viewer.id}
          onPeople={onPeople}
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
          if (!confirmDelete || deleting) return;
          setDeleting(true);
          let err: string | null;
          try {
            err = await onDelete(confirmDelete.id);
          } catch {
            err = OFFLINE;
          } finally {
            setDeleting(false);
          }
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

      {reportDeleted && channel?.kind === "channel" ? (
        <ReportDeletedDialog
          channel={channel}
          people={people}
          preselect={reportDeleted.preselect}
          moderator={viewer.staff}
          onClose={() => setReportDeleted(null)}
          onDone={() => {
            setReportDeleted(null);
            setNotice("Reported. The batch0 team will look at it. Nobody else is told who reported.");
          }}
        />
      ) : null}

      {flagging && channel ? (
        <FlagDialog
          message={flagging}
          people={people}
          onClose={() => setFlagging(null)}
          onDone={() => {
            setFlagging(null);
            setNotice("Sent to the batch0 team. Someone will take a look.");
          }}
        />
      ) : null}

      {muting ? (
        <MuteDialog
          userId={muting.userId}
          name={muting.name}
          onClose={() => setMuting(null)}
          onDone={(text) => {
            setMuting(null);
            setNotice(text);
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
            onChannelChanged(channel.id);
          }}
        />
      ) : null}
      {dialog === "rename" && channel ? (
        <RenameGroupDialog
          channel={channel}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onChannelChanged(channel.id);
          }}
        />
      ) : null}
      {dialog === "add" && channel ? (
        <AddPeopleDialog
          channel={channel}
          self={viewer.staff ? null : (people[viewer.id] ?? null)}
          onClose={() => setDialog(null)}
          onSaved={(n) => {
            setDialog(null);
            setNotice(`Added ${n === 1 ? "1 person" : `${n} people`}.`);
            membersFor.current = null;
            onChannelChanged(channel.id);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={dialog === "leave"}
        title="Leave this group?"
        description="You won't see new messages. Someone in it can add you back."
        confirmLabel="Leave"
        destructive
        pending={leaving}
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          if (!channel || leaving) return;
          const id = channel.id;
          setLeaving(true);
          let res: ActionResult;
          try {
            res = await tracked(leaveGroup(id));
          } catch {
            res = { ok: false, error: OFFLINE };
          } finally {
            setLeaving(false);
          }
          setDialog(null);
          if (!res.ok) noticeFor(id, resultError(res, "Couldn't leave the group."));
          else onLeft(id);
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
        <p className="break-words font-display text-3xl text-ink">{label}</p>
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
        <p className="break-words font-display text-3xl text-ink">Welcome to #{label}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {c.topic ?? "This is the start of the channel."}
          {c.posting === "staff" ? " Only the batch0 team posts here; you can react." : ""}
          {c.slowmodeSeconds ? ` Slow mode is on: one message every ${c.slowmodeSeconds}s.` : ""}
        </p>
      </div>
    );
  }
  if (c.moderatorView) {
    return (
      <div>
        <p className="break-words font-display text-3xl text-ink">{label}</p>
        <p className="mt-1 text-sm text-ink-soft">
          This is the start of the {c.kind === "group" ? "group" : "conversation"}. You can read it because it was reported.
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="break-words font-display text-3xl text-ink">{label}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {c.kind === "group" ? "This is the start of the group." : `This is the start of your conversation with ${label}.`} Only the people in it can read it — unless someone in it reports it to the batch0 team.
      </p>
    </div>
  );
}

const HeaderButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    active?: boolean;
    /** It opens a side panel: which one (focus comes back here when it closes). */
    panel?: Exclude<Panel, null>;
    /** It opens a menu. */
    menu?: boolean;
    expanded?: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }
>(function HeaderButton({ label, active, panel, menu, expanded, onClick, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={menu ? undefined : !!active}
      aria-haspopup={menu ? "menu" : undefined}
      aria-expanded={menu ? !!expanded : undefined}
      data-panel-toggle={panel}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md ${active || expanded ? "bg-wash text-ink" : "text-ink-soft hover:bg-wash hover:text-ink"}`}
    >
      {children}
    </button>
  );
});

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
      <span className="min-w-0 flex-1 break-words">{children}</span>
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
      <span className="min-w-0 truncate text-sm font-semibold text-ink">{title}</span>
    </div>
  );
}
