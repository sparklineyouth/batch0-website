"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Loader2, Lock, Megaphone, Search, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  REPORT_REASON_MAX,
  SLOWMODE_CHOICES,
  TOPIC_MAX,
  normalizeChannelName,
  type Posting,
} from "@/lib/chat-access";
import { plainText } from "@/lib/chat-format";
import {
  addToGroup,
  createGroup,
  fetchBlockedPeople,
  renameGroup,
  reportConversation,
  reportMessage,
  searchPeople,
  unblockPerson,
} from "@/app/chat/actions";
import { addChannelMembers, updateChannel } from "@/app/chat/manage-actions";
import { Avatar, RoleTag } from "./avatar";
import { Modal } from "./modal";
import { resultError } from "./util";
import type { ChannelInfo, ChatPerson, ChatViewerInfo, SidebarData, UiMessage } from "./types";

const field =
  "w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none";

function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{text}</p> : null;
}

/** The directory search shared by "new message" and "add people". */
function usePeopleSearch(open: boolean) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const found = await searchPeople(query);
        if (n === seq.current) setResults(found);
      } catch {
        if (n === seq.current) setResults([]);
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);
  return { query, setQuery, results, loading };
}

function PeoplePicker({
  open,
  picked,
  setPicked,
  max,
  exclude = [],
}: {
  open: boolean;
  picked: ChatPerson[];
  setPicked: (p: ChatPerson[]) => void;
  max: number;
  exclude?: readonly string[];
}) {
  const { query, setQuery, results, loading } = usePeopleSearch(open);
  const shown = results.filter((p) => !exclude.includes(p.id));
  const toggle = (p: ChatPerson) => {
    if (picked.some((x) => x.id === p.id)) setPicked(picked.filter((x) => x.id !== p.id));
    else if (picked.length < max) setPicked([...picked, p]);
  };
  return (
    <div>
      {picked.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-md border border-line bg-wash py-0.5 pl-2 pr-1 text-xs text-ink">
              {p.name}
              <button type="button" onClick={() => toggle(p)} aria-label={`Remove ${p.name}`} className="rounded hover:bg-paper">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          className={`${field} pl-9`}
          aria-label="Search people"
        />
      </div>
      <ul className="mt-2 max-h-72 overflow-y-auto">
        {loading && shown.length === 0 ? (
          <li className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></li>
        ) : shown.length === 0 ? (
          <li className="py-6 text-center text-xs text-ink-faint">{query ? "Nobody by that name you can message." : "Nobody to show yet."}</li>
        ) : (
          shown.map((p) => {
            const on = picked.some((x) => x.id === p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => toggle(p)}
                  aria-pressed={on}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${on ? "bg-phosphor/15" : "hover:bg-wash"}`}
                >
                  <Avatar name={p.name} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
                  <RoleTag person={p} />
                  <span className={`h-4 w-4 shrink-0 rounded border ${on ? "border-phosphor bg-phosphor" : "border-line"}`} aria-hidden />
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

/** New DM (one person) or new group (several). */
export function NewConversationDialog({
  open,
  viewer,
  onClose,
  onOpenDraft,
  onOpenChannel,
}: {
  open: boolean;
  viewer: ChatViewerInfo;
  onClose: () => void;
  onOpenDraft: (userId: string) => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const [picked, setPicked] = useState<ChatPerson[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked([]);
      setName("");
      setError(null);
    }
  }, [open]);
  const go = async () => {
    if (picked.length === 0) return;
    if (picked.length === 1) {
      onOpenDraft(picked[0].id);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await createGroup({ userIds: picked.map((p) => p.id), name });
    setBusy(false);
    if (!res.ok || !res.data) setError(resultError(res, "Couldn't start the group."));
    else onOpenChannel(res.data.channelId);
  };
  return (
    <Modal open={open} title="New message" onClose={onClose} busy={busy}>
      <p className="mb-3 text-xs text-ink-soft">
        {viewer.vetted || viewer.staff
          ? `Pick one person for a DM, or up to ${GROUP_MAX_MEMBERS - 1} for a group.`
          : "For now you can message the batch0 team. Everyone else opens once you've been accepted."}
      </p>
      <PeoplePicker open={open} picked={picked} setPicked={setPicked} max={viewer.vetted || viewer.staff ? GROUP_MAX_MEMBERS - 1 : 1} />
      {picked.length > 1 ? (
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, GROUP_NAME_MAX))}
          placeholder="Group name (optional)"
          className={`${field} mt-3`}
          aria-label="Group name"
        />
      ) : null}
      <ErrorLine text={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={go} disabled={picked.length === 0 || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {picked.length > 1 ? "Start group" : "Message"}
        </Button>
      </div>
    </Modal>
  );
}

/** ⌘K: jump to any channel or conversation by name. */
export function QuickSwitcher({
  open,
  sidebar,
  onClose,
  onOpen,
}: {
  open: boolean;
  sidebar: SidebarData;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (open) {
      setQ("");
      setIndex(0);
    }
  }, [open]);
  const items = useMemo(() => {
    const all = [...sidebar.channels, ...sidebar.conversations];
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    const hits = needle ? all.filter((i) => i.label.toLowerCase().includes(needle)) : all;
    // Unread first when browsing; best match first when typing.
    return hits
      .slice()
      .sort((a, b) =>
        needle
          ? Number(b.label.toLowerCase().startsWith(needle)) - Number(a.label.toLowerCase().startsWith(needle))
          : Number(b.unread > 0) - Number(a.unread > 0),
      )
      .slice(0, 12);
  }, [q, sidebar]);
  useEffect(() => setIndex(0), [q]);
  return (
    <Modal open={open} title="Jump to" onClose={onClose}>
      <input
        data-autofocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && items[index]) {
            e.preventDefault();
            onOpen(items[index].id);
          }
        }}
        placeholder="Where to?"
        className={field}
        aria-label="Search channels and conversations"
      />
      <ul className="mt-2">
        {items.map((i, n) => {
          const Icon = i.kind === "channel" ? (i.posting === "staff" ? Megaphone : i.audience === "everyone" || i.audience === "cohort" ? Hash : Lock) : i.kind === "group" ? Users : null;
          return (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => onOpen(i.id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${n === index ? "bg-wash" : "hover:bg-wash"}`}
              >
                {Icon ? <Icon className="h-4 w-4 text-ink-faint" /> : <Avatar name={i.label} size={22} />}
                <span className={`min-w-0 flex-1 truncate ${i.unread ? "font-semibold text-ink" : "text-ink-soft"}`}>{i.label}</span>
                {i.unread ? <span className="h-1.5 w-1.5 rounded-full bg-ink" /> : null}
              </button>
            </li>
          );
        })}
        {items.length === 0 ? <li className="py-4 text-center text-xs text-ink-faint">Nothing matches.</li> : null}
      </ul>
    </Modal>
  );
}

/** Your block list — a block can exist with no conversation, so there has to be a way back. */
export function BlockedPeopleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [people, setPeople] = useState<ChatPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPeople(null);
    fetchBlockedPeople().then(setPeople).catch(() => setError("Couldn't load your block list."));
  }, [open]);
  return (
    <Modal open={open} title="Blocked" onClose={onClose}>
      <p className="mb-3 text-xs text-ink-soft">
        Blocked people can&apos;t DM you and you can&apos;t DM them; their messages collapse in channels. They&apos;re never told.
      </p>
      {people === null && !error ? (
        <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" /></div>
      ) : people && people.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-faint">You haven&apos;t blocked anyone.</p>
      ) : (
        <ul className="divide-y divide-line">
          {(people ?? []).map((p) => (
            <li key={p.id} className="flex items-center gap-2.5 py-2">
              <Avatar name={p.name} size={28} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const res = await unblockPerson(p.id);
                  if (res.ok) setPeople((list) => (list ?? []).filter((x) => x.id !== p.id));
                  else setError(resultError(res, "Couldn't unblock."));
                }}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine text={error} />
    </Modal>
  );
}

/**
 * Report a message or a whole DM/group. The dialog says, before anyone
 * commits, that a report hands the conversation to the team — the one moment
 * the privacy promise changes.
 */
export function ReportDialog({
  channel,
  message,
  people,
  onClose,
  onDone,
}: {
  channel: ChannelInfo;
  message: UiMessage | null;
  people: Record<string, ChatPerson>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const privateThread = channel.kind !== "channel";
  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = message
      ? await reportMessage({ messageId: message.id, reason })
      : await reportConversation({ channelId: channel.id, reason });
    setBusy(false);
    if (!res.ok) setError(resultError(res, "Couldn't send the report."));
    else onDone();
  };
  return (
    <Modal open title={message ? "Report message" : "Report conversation"} onClose={onClose} busy={busy}>
      {message ? (
        <blockquote className="mb-3 border-l-2 border-line pl-3 text-sm text-ink-soft">
          <strong className="text-ink">{message.senderId ? (people[message.senderId]?.name ?? "Someone") : "batch0"}:</strong>{" "}
          {plainText(message.body || "[attachment]", (id) => people[id]?.name, () => null, 200)}
        </blockquote>
      ) : null}
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        {privateThread
          ? "Reporting hands this whole conversation — your messages included — to the batch0 team so they can act on it. Nobody else in it is told who reported."
          : "The batch0 team will see the message and your reason. The person you report isn't told who reported them."}
      </p>
      <textarea
        data-autofocus
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, REPORT_REASON_MAX))}
        rows={4}
        placeholder="What's wrong? A sentence or two is plenty."
        className={field}
        aria-label="Reason"
      />
      <ErrorLine text={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy || !reason.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Send report
        </Button>
      </div>
    </Modal>
  );
}

/** Staff: name, topic, who posts, slow mode. Audience is edited from Admin → Chat. */
export function ChannelSettingsDialog({ channel, onClose, onSaved }: { channel: ChannelInfo; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(channel.name ?? "");
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [posting, setPosting] = useState<Posting>(channel.posting);
  const [slowmode, setSlowmode] = useState(channel.slowmodeSeconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await updateChannel(channel.id, {
      name,
      topic,
      audience: channel.audience,
      cohortId: channel.cohortId,
      teamId: channel.teamId,
      posting,
      slowmodeSeconds: slowmode,
    });
    setBusy(false);
    if (!res.ok) setError(resultError(res, "Couldn't save the channel."));
    else onSaved();
  };
  return (
    <Modal open title="Edit channel" onClose={onClose} busy={busy}>
      <label className="block text-xs font-medium text-ink-soft">
        Name
        <div className="relative mt-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">#</span>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setName(normalizeChannelName(name))} className={`${field} pl-7`} />
        </div>
      </label>
      <label className="mt-3 block text-xs font-medium text-ink-soft">
        Topic
        <input value={topic} onChange={(e) => setTopic(e.target.value.slice(0, TOPIC_MAX))} className={`${field} mt-1`} placeholder="What this channel is for" />
      </label>
      <label className="mt-3 block text-xs font-medium text-ink-soft">
        Who can post
        <select value={posting} onChange={(e) => setPosting(e.target.value as Posting)} className={`${field} mt-1`}>
          <option value="everyone">Everyone who can see it</option>
          <option value="staff">Only staff (read-only for everyone else)</option>
        </select>
      </label>
      <label className="mt-3 block text-xs font-medium text-ink-soft">
        Slow mode
        <select value={slowmode} onChange={(e) => setSlowmode(Number(e.target.value))} className={`${field} mt-1`}>
          {SLOWMODE_CHOICES.map((s) => (
            <option key={s} value={s}>{s === 0 ? "Off" : s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minutes` : "1 hour"}</option>
          ))}
        </select>
      </label>
      <p className="mt-3 text-[11px] text-ink-faint">Who can see the channel is set in Admin → Chat.</p>
      <ErrorLine text={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={save} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save</Button>
      </div>
    </Modal>
  );
}

export function RenameGroupDialog({ channel, onClose, onSaved }: { channel: ChannelInfo; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(channel.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open title="Rename group" onClose={onClose} busy={busy}>
      <input data-autofocus value={name} onChange={(e) => setName(e.target.value.slice(0, GROUP_NAME_MAX))} placeholder="Leave empty to use members' names" className={field} aria-label="Group name" />
      <ErrorLine text={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await renameGroup(channel.id, name);
            setBusy(false);
            if (!res.ok) setError(resultError(res, "Couldn't rename the group."));
            else onSaved();
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

/** Add people: to a group (any member), or to a text channel beyond its audience (staff). */
export function AddPeopleDialog({ channel, onClose, onSaved }: { channel: ChannelInfo; onClose: () => void; onSaved: (n: number) => void }) {
  const [picked, setPicked] = useState<ChatPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isGroup = channel.kind === "group";
  const max = isGroup ? Math.max(0, GROUP_MAX_MEMBERS - channel.memberIds.length) : 50;
  return (
    <Modal open title={isGroup ? "Add people to the group" : `Add people to #${channel.label}`} onClose={onClose} busy={busy}>
      <p className="mb-3 text-xs text-ink-soft">
        {isGroup
          ? `A group holds up to ${GROUP_MAX_MEMBERS} people. They'll see the whole history.`
          : "These people get the channel on top of its audience — a mentor in a cohort channel, members of a private one."}
      </p>
      {max === 0 ? (
        <p className="text-sm text-ink-soft">This group is full.</p>
      ) : (
        <PeoplePicker open picked={picked} setPicked={setPicked} max={max} exclude={channel.memberIds} />
      )}
      <ErrorLine text={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          disabled={busy || picked.length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const ids = picked.map((p) => p.id);
            const res = isGroup ? await addToGroup(channel.id, ids) : await addChannelMembers(channel.id, ids);
            setBusy(false);
            if (!res.ok) setError(resultError(res, "Couldn't add them."));
            else onSaved(ids.length);
          }}
        >
          Add {picked.length || ""}
        </Button>
      </div>
    </Modal>
  );
}
