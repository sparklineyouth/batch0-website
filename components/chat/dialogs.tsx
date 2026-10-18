"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Hash, Loader2, Lock, Megaphone, Search, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX,
  REPORT_REASON_MAX,
  SLOWMODE_CHOICES,
  TOPIC_MAX,
  normalizeChannelName,
  pickRefusal,
  withheldHint,
  type Party,
  type Posting,
  outsideReportAdvice,
  type ReportOutcome,
} from "@/lib/chat-access";
import { plainText } from "@/lib/chat-format";
import type { ActionResult } from "@/lib/action-result";
import {
  addToGroup,
  createGroup,
  fetchBlockedPeople,
  fetchDeletedMessages,
  flagForTeam,
  type FlagResult,
  renameGroup,
  reportConversation,
  reportMessage,
  searchPeople,
  unblockPerson,
  type DirectoryGroup,
} from "@/app/chat/actions";
import { addChannelMembers, mutePerson, unmutePerson, updateChannel } from "@/app/chat/manage-actions";
import { Avatar, RoleTag } from "./avatar";
import { Modal } from "./modal";
import { tracked } from "./api";
import { OFFLINE, appendStubs, resultError, senderName, stampLabel } from "./util";
import type { ChannelInfo, ChatPerson, ChatViewerInfo, SidebarData, UiMessage } from "./types";
import type { DeletedMessageStub } from "@/lib/chat";

// 16px on phones: iOS Safari zooms the page into any smaller field it focuses.
const field =
  "w-full rounded-md border border-line bg-paper px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none md:text-sm";

/**
 * Run a write for a dialog: never throws (a dropped connection, or a deploy
 * that swapped the actions out, is an answer like any other), so `busy`
 * always comes back down and the dialog can always be closed.
 */
async function attempt<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await tracked(run());
  } catch {
    return { ok: false, error: OFFLINE };
  }
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{text}</p> : null;
}

/**
 * The directory search shared by "new message" and "add people". `group`
 * makes it a search for a group (searchPeople): whoever may join it with the
 * people already in it, not only whom the viewer could DM. `withheld`: the
 * safeguarding rule alone left someone matching out.
 */
function usePeopleSearch(open: boolean, group: DirectoryGroup | null) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatPerson[]>([]);
  const [withheld, setWithheld] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const groupKey = group ? `${group.channelId ?? ""}|${[...(group.withIds ?? [])].sort().join(",")}` : null;
  const groupRef = useRef(group);
  groupRef.current = group;
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const found = await tracked(searchPeople(query, groupRef.current));
        if (n === seq.current) {
          setResults(found.people);
          setWithheld(found.withheld);
        }
      } catch {
        if (n === seq.current) {
          setResults([]);
          setWithheld(false);
        }
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, open, groupKey]);
  return { query, setQuery, results, withheld, loading };
}

/** A person as the safeguarding rule sees them, on this side (lib/chat.ts asParty). */
const party = (p: ChatPerson): Party => ({ id: p.id, student: p.isStudent, staff: p.isStaff });

function PeoplePicker({
  open,
  picked,
  setPicked,
  max,
  exclude = [],
  group = null,
  hint = null,
}: {
  open: boolean;
  picked: ChatPerson[];
  setPicked: (p: ChatPerson[]) => void;
  max: number;
  exclude?: readonly string[];
  /** Picking for a group: an existing one (its id), or a new one (null). The picks so far ride along. */
  group?: { channelId: string | null } | null;
  /**
   * What would let more people in (withheldHint), said only when the search
   * says the safeguarding rule left someone matching out — never under a
   * search that found nobody for any other reason.
   */
  hint?: string | null;
}) {
  const search = group ? { channelId: group.channelId, withIds: picked.map((p) => p.id) } : null;
  const { query, setQuery, results, withheld, loading } = usePeopleSearch(open, search);
  const showHint = !!hint && withheld && !loading;
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
          <li className="py-6 text-center text-xs text-ink-faint">
            {query ? "Nobody by that name you can message." : "Nobody to show yet."}
          </li>
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
      {showHint ? (
        <p className="mt-1 text-center text-xs text-ink-soft" role="status">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * New DM (one person) or new group (several). Nobody picked yet, the
 * directory is a DM's; from the first pick on, it's the group's — so once
 * someone from the batch0 team is picked, a student also finds the mentor
 * the group may hold. The server checks the whole group again on create.
 */
export function NewConversationDialog({
  open,
  viewer,
  self,
  onClose,
  onOpenDraft,
  onOpenChannel,
}: {
  open: boolean;
  viewer: ChatViewerInfo;
  /** The viewer as a person (the sidebar names them): whether they're a student. */
  self: ChatPerson | null;
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
  // The rule the server will hold this group (or DM) to, said before the
  // click rather than after, in the words the server would use: a mentor
  // picked while a staff member was, and then the staff member taken out,
  // leaves one it refuses.
  const me = viewer.staff || !self ? null : party(self);
  const refusal = pickRefusal(me, picked.map(party));
  const allowed = refusal === null;
  const go = async () => {
    if (picked.length === 0 || !allowed) return;
    if (picked.length === 1) {
      onOpenDraft(picked[0].id);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await attempt(() => createGroup({ userIds: picked.map((p) => p.id), name }));
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
      <PeoplePicker
        open={open}
        picked={picked}
        setPicked={setPicked}
        max={viewer.vetted || viewer.staff ? GROUP_MAX_MEMBERS - 1 : 1}
        group={picked.length > 0 && (viewer.vetted || viewer.staff) ? { channelId: null } : null}
        hint={me && viewer.vetted ? withheldHint(me) : null}
      />
      {refusal ? (
        <p className="mt-2 text-xs text-ink-soft" role="status">{refusal}</p>
      ) : null}
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
        <Button onClick={go} disabled={picked.length === 0 || !allowed || busy}>
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
  const ids = useId();
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
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={`${ids}-list`}
        aria-autocomplete="list"
        aria-activedescendant={items[index] ? `${ids}-${index}` : undefined}
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
      <ul id={`${ids}-list`} role="listbox" aria-label="Channels and conversations" className="mt-2">
        {items.map((i, n) => {
          const Icon = i.kind === "channel" ? (i.posting === "staff" ? Megaphone : i.audience === "everyone" || i.audience === "cohort" ? Hash : Lock) : i.kind === "group" ? Users : null;
          return (
            <li
              key={i.id}
              id={`${ids}-${n}`}
              role="option"
              aria-selected={n === index}
              onClick={() => onOpen(i.id)}
              onMouseMove={() => setIndex(n)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${n === index ? "bg-wash" : "hover:bg-wash"}`}
            >
              {Icon ? <Icon className="h-4 w-4 text-ink-faint" aria-hidden /> : <Avatar name={i.label} size={22} />}
              <span className={`min-w-0 flex-1 truncate ${i.unread ? "font-semibold text-ink" : "text-ink-soft"}`}>{i.label}</span>
              {i.unread ? <span className="h-1.5 w-1.5 rounded-full bg-ink" aria-label="Unread" /> : null}
            </li>
          );
        })}
      </ul>
      {items.length === 0 ? <p className="py-4 text-center text-xs text-ink-faint" role="status">Nothing matches.</p> : null}
    </Modal>
  );
}

/** Your block list — a block can exist with no conversation, so there has to be a way back. */
export function BlockedPeopleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [people, setPeople] = useState<ChatPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPeople(null);
    setError(null);
    tracked(fetchBlockedPeople())
      .then((list) => live && setPeople(list))
      .catch(() => live && setError("Couldn't load your block list. Close this and try again."));
    return () => {
      live = false;
    };
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
                disabled={busy === p.id}
                onClick={async () => {
                  setBusy(p.id);
                  setError(null);
                  const res = await attempt(() => unblockPerson(p.id));
                  setBusy(null);
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
  /** The team was told. An "outside" report stays open here, with what to do next. */
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outside, setOutside] = useState<string[] | null>(null);
  const privateThread = channel.kind !== "channel";
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await attempt(() =>
      message ? reportMessage({ messageId: message.id, reason }) : reportConversation({ channelId: channel.id, reason }),
    );
    setBusy(false);
    if (!res.ok) return setError(resultError(res, "Couldn't send the report."));
    const outcome: ReportOutcome | undefined = res.data;
    // Nobody on the team can be shown it: say so, and where to go instead,
    // rather than "the team will look at it".
    if (outcome?.routedTo === "outside") setOutside(outsideReportAdvice(outcome.safeguardingEmail));
    else onDone();
  };
  if (outside) return <ReportSaved advice={outside} onClose={onClose} />;
  return (
    <Modal open title={message ? "Report message" : "Report conversation"} onClose={onClose} busy={busy}>
      {message ? (
        <blockquote className="mb-3 border-l-2 border-line pl-3 text-sm text-ink-soft">
          <strong className="text-ink">{senderName(message, people)}:</strong>{" "}
          {plainText(message.body || "[attachment]", (id) => people[id]?.name, () => null, 200)}
        </blockquote>
      ) : null}
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        {privateThread
          ? "Reporting hands this whole conversation — your messages included — to the batch0 team so they can act on it. Nobody else in it is told who reported."
          : "The batch0 team will see the message and your reason. The person you report isn't told who reported them."}{" "}
        <Link href="/community-guidelines" target="_blank" className="link-ink">
          Community guidelines
        </Link>
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

/** After a report nobody on the team can be shown: it's saved, and where to go now. */
function ReportSaved({ advice, onClose }: { advice: string[]; onClose: () => void }) {
  return (
    <Modal open title="Your report is saved" onClose={onClose}>
      <div className="space-y-3 text-sm leading-relaxed text-ink" role="status">
        {advice.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className="text-xs text-ink-soft">
          <Link href="/community-guidelines" target="_blank" className="link-ink">
            Community guidelines
          </Link>
        </p>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

/**
 * Report something posted in a text channel and then deleted. History and
 * search leave deleted messages out, and only a DM or group can be reported
 * whole, so this lists the channel's recently deleted messages as stubs —
 * who sent it and when, never what it said (fetchDeletedMessages) — a page
 * at a time, so a pile of later deletes only pushes the one that matters
 * further down, and files an ordinary report on the one picked. The report
 * page shows what it said to the moderators the report leaves out (never to
 * its sender). A reporter who isn't one doesn't see it again; a moderator who
 * files one reviews it like any report, and is told so up front.
 */
export function ReportDeletedDialog({
  channel,
  people,
  preselect,
  moderator,
  onClose,
  onDone,
}: {
  channel: ChannelInfo;
  people: Record<string, ChatPerson>;
  /** Opened from a reply's "Original message was deleted": that message. */
  preselect: { id: string; senderId: string } | null;
  /** The viewer runs chat (chat.manage): the report page will show them what it said. */
  moderator: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [stubs, setStubs] = useState<DeletedMessageStub[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [names, setNames] = useState<Record<string, ChatPerson>>({});
  const [picked, setPicked] = useState<string | null>(preselect?.id ?? null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outside, setOutside] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    tracked(fetchDeletedMessages(channel.id))
      .then((res) => {
        if (!live) return;
        setStubs(res.messages);
        setMore(res.hasMore);
        setNames(res.people);
      })
      .catch(() => {
        if (!live) return;
        setStubs([]);
        setError("Couldn't load the deleted messages. Close this and try again.");
      });
    return () => {
      live = false;
    };
  }, [channel.id]);
  const loadOlder = async () => {
    const last = stubs?.at(-1);
    if (!last || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await tracked(fetchDeletedMessages(channel.id, { deletedAt: last.deletedAt, id: last.id }));
      setStubs((now) => appendStubs(now ?? [], res.messages));
      setMore(res.hasMore);
      setNames((now) => ({ ...now, ...res.people }));
    } catch {
      setError("Couldn't load older ones. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };
  // The quoted original stays pickable when the list hasn't reached it.
  const rows = useMemo(() => {
    const list = stubs ?? [];
    if (!preselect || list.some((m) => m.id === preselect.id)) return list;
    return [{ id: preselect.id, senderId: preselect.senderId, createdAt: "", deletedAt: "" }, ...list];
  }, [stubs, preselect]);
  const who = (id: string) => (names[id] ?? people[id])?.name ?? "Deleted account";
  const submit = async () => {
    if (busy || !picked) return;
    setBusy(true);
    setError(null);
    const res = await attempt(() => reportMessage({ messageId: picked, reason }));
    setBusy(false);
    if (!res.ok) return setError(resultError(res, "Couldn't send the report."));
    const outcome: ReportOutcome | undefined = res.data;
    if (outcome?.routedTo === "outside") setOutside(outsideReportAdvice(outcome.safeguardingEmail));
    else onDone();
  };
  if (outside) return <ReportSaved advice={outside} onClose={onClose} />;
  return (
    <Modal open title="Report a deleted message" onClose={onClose} busy={busy}>
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        {moderator ? (
          <>
            Something posted in #{channel.label} and then deleted? Pick it and say what was wrong. As a moderator
            you&apos;ll see what it said on the report page, as with any report you file, and the rest of the team sees
            that you filed it. The person you report isn&apos;t told who reported them.{" "}
          </>
        ) : (
          <>
            Something posted in #{channel.label} and then deleted? Pick it and say what was wrong. The batch0 team can
            still see what it said; you won&apos;t see it here again, and the person you report isn&apos;t told who
            reported them.{" "}
          </>
        )}
        <Link href="/community-guidelines" target="_blank" className="link-ink">
          Community guidelines
        </Link>
      </p>
      {stubs === null ? (
        <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-ink-faint" aria-label="Loading" /></div>
      ) : rows.length === 0 ? (
        error ? null : (
          <p className="py-4 text-center text-xs text-ink-faint" role="status">
            Nothing here has been deleted in the last two weeks.
          </p>
        )
      ) : (
        <ul className="max-h-60 overflow-y-auto" aria-label="Deleted messages">
          {rows.map((m) => {
            const on = picked === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setPicked(on ? null : m.id)}
                  aria-pressed={on}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${on ? "bg-phosphor/15" : "hover:bg-wash"}`}
                >
                  <Avatar name={who(m.senderId)} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{who(m.senderId)}</span>
                    <span className="block truncate text-xs italic text-ink-faint">
                      {m.createdAt ? `Message deleted · ${stampLabel(m.createdAt)}` : "The deleted message that was replied to"}
                    </span>
                  </span>
                  <span className={`h-4 w-4 shrink-0 rounded-full border ${on ? "border-phosphor bg-phosphor" : "border-line"}`} aria-hidden />
                </button>
              </li>
            );
          })}
          {more ? (
            <li className="flex justify-center pt-1">
              <Button variant="ghost" onClick={loadOlder} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Show older
              </Button>
            </li>
          ) : null}
        </ul>
      )}
      {rows.length > 0 ? (
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REPORT_REASON_MAX))}
          rows={3}
          placeholder="What was wrong with it? A sentence or two is plenty."
          className={`${field} mt-3`}
          aria-label="Reason"
        />
      ) : null}
      <ErrorLine text={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy || !picked || !reason.trim()}>
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
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await attempt(() =>
      updateChannel(channel.id, {
        name,
        topic,
        audience: channel.audience,
        cohortId: channel.cohortId,
        teamId: channel.teamId,
        posting,
        slowmodeSeconds: slowmode,
      }),
    );
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
            setError(null);
            const res = await attempt(() => renameGroup(channel.id, name));
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
export function AddPeopleDialog({
  channel,
  self,
  onClose,
  onSaved,
}: {
  channel: ChannelInfo;
  /** The viewer as a person, null for staff: who the safeguarding rule would keep out of the group. */
  self: ChatPerson | null;
  onClose: () => void;
  onSaved: (n: number) => void;
}) {
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
        <PeoplePicker
          open
          picked={picked}
          setPicked={setPicked}
          max={max}
          exclude={channel.memberIds}
          group={isGroup ? { channelId: channel.id } : null}
          hint={isGroup && self ? withheldHint(party(self)) : null}
        />
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
            const res = await attempt<unknown>(() => (isGroup ? addToGroup(channel.id, ids) : addChannelMembers(channel.id, ids)));
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

/**
 * "Ask the team for help" on a message: every chat moderator gets a bell
 * that opens it. Not a report — nobody is in trouble — so it hands over
 * nothing but the link and the note. With threads (0110) it also files, or
 * joins, the thread's one help request in Support: `onDone` gets its
 * reference (for its requester and the team only), and whether this made a
 * new one, joined the one already open or put it back with the team.
 * Educational help only — the copy points safety worries at Report, which
 * is its own confidential queue.
 */
export function FlagDialog({
  message,
  people,
  threads = false,
  onClose,
  onDone,
}: {
  message: UiMessage;
  people: Record<string, ChatPerson>;
  /** The channel has threads: the request is the thread's, and is tracked in Support. */
  threads?: boolean;
  onClose: () => void;
  onDone: (result: FlagResult | null) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await attempt(() => flagForTeam(message.id, note));
    setBusy(false);
    if (!res.ok) setError(resultError(res, "Couldn't reach the team. Try again."));
    else onDone(res.data ?? null);
  };
  return (
    <Modal open title="Ask the team for help" onClose={onClose} busy={busy}>
      <blockquote className="mb-3 border-l-2 border-line pl-3 text-sm text-ink-soft">
        <strong className="text-ink">{senderName(message, people)}:</strong>{" "}
        {plainText(message.body || "[attachment]", (id) => people[id]?.name, () => null, 200)}
      </blockquote>
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        {threads
          ? "Someone on the batch0 team picks it up as a help request for this thread, and the thread shows when it's handled. If the thread already has one, the team is told you asked too. Use it when someone's stuck or something needs a staff eye."
          : "The batch0 team gets a notification that opens this message. Use it when someone's stuck or something needs a staff eye."}{" "}
        If something here is unsafe or upsetting, use Report instead: it goes to the team privately.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          data-autofocus
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 300))}
          placeholder="What do you need? (optional)"
          className={field}
          aria-label="What do you need?"
          maxLength={300}
        />
        <ErrorLine text={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Ask the team
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const MUTE_CHOICES: { minutes: number | null; label: string }[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 60 * 24, label: "24 hours" },
  { minutes: 60 * 24 * 7, label: "7 days" },
  { minutes: null, label: "Until lifted" },
];

/**
 * Staff: stop someone posting in chat for a while. They can still read,
 * report, block and message the team; the composer tells them why it's off.
 */
export function MuteDialog({
  userId,
  name,
  onClose,
  onDone,
}: {
  userId: string;
  name: string;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const [choice, setChoice] = useState(1);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const run = async (lift: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const pick = MUTE_CHOICES[choice];
    const res = await attempt(() => (lift ? unmutePerson(userId) : mutePerson(userId, pick.minutes, reason)));
    setBusy(false);
    if (!res.ok) setError(resultError(res, lift ? "Couldn't lift the mute." : "Couldn't mute them."));
    else onDone(lift ? `${name} can post again.` : `${name} is muted in chat${pick.minutes === null ? " until you lift it" : ` for ${pick.label}`}.`);
  };
  return (
    <Modal open title={`Mute ${name} in chat`} onClose={onClose} busy={busy}>
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        They can still read, report, block and message the batch0 team, but can&apos;t post, react or start conversations.
        Their composer says so. The mute is logged.
      </p>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-ink-soft">For how long</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {MUTE_CHOICES.map((c, i) => (
            <label
              key={c.label}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm ${choice === i ? "border-ink/40 bg-wash text-ink" : "border-line text-ink-soft"}`}
            >
              <input type="radio" name={`${ids}-mute`} checked={choice === i} onChange={() => setChoice(i)} className="accent-current" />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 block text-xs font-medium text-ink-soft">
        Why (staff see this)
        <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} className={`${field} mt-1`} placeholder="e.g. spamming #general after a warning" />
      </label>
      <ErrorLine text={error} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="link-ink text-xs" onClick={() => void run(true)} disabled={busy}>
          Lift a mute instead
        </button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void run(false)} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Mute
          </Button>
        </div>
      </div>
    </Modal>
  );
}
