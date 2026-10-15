"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, Hash, Lock, Megaphone, Pencil, Plus, Trash2, UserMinus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { Modal } from "@/components/chat/modal";
import { resultError } from "@/components/chat/util";
import { AUDIENCES, SLOWMODE_CHOICES, TOPIC_MAX, normalizeChannelName, type Audience, type Posting } from "@/lib/chat-access";
import {
  createChannel,
  deleteChannel,
  removeChannelMember,
  setChannelArchived,
  updateChannel,
  type ChannelInput,
} from "@/app/chat/manage-actions";

export type ChannelAdminRow = {
  id: string;
  name: string;
  topic: string | null;
  audience: Audience;
  cohortId: string | null;
  teamId: string | null;
  audienceLabel: string;
  posting: Posting;
  slowmodeSeconds: number;
  position: number;
  system: boolean;
  archived: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  members: { id: string; name: string }[];
};

type Option = { id: string; name: string };

const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: "Everyone let in (accepted students, mentors, investors, staff)",
  cohort: "One cohort",
  team: "One team",
  staff: "Staff only",
  members: "Only people I add",
};

const field =
  "w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ink/40 focus:outline-none";

function slowLabel(s: number) {
  return s === 0 ? "Off" : s < 60 ? `${s}s` : s < 3600 ? `${s / 60} min` : "1 hour";
}

export function ChannelAdmin({ rows, cohorts, teams }: { rows: ChannelAdminRow[]; cohorts: Option[]; teams: Option[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<ChannelAdminRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<ChannelAdminRow | null>(null);
  const [membersOf, setMembersOf] = useState<ChannelAdminRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const shown = rows.filter((r) => showArchived || !r.archived);
  const archivedCount = rows.filter((r) => r.archived).length;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Channels · {rows.length - archivedCount}</h2>
        <div className="flex items-center gap-3">
          {archivedCount > 0 ? (
            <button type="button" className="text-xs link-ink" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          ) : null}
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" />
            New channel
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Every cohort and team gets its own channel automatically. Lower position numbers sort first in the sidebar.
      </p>
      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      <div className="mt-3 overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line bg-wash text-[11px] uppercase tracking-wider text-ink-faint">
            <tr>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium">Who sees it</th>
              <th className="px-3 py-2 font-medium">Posting</th>
              <th className="px-3 py-2 font-medium">Messages</th>
              <th className="px-3 py-2 font-medium">Last activity</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => {
              const Icon = r.posting === "staff" ? Megaphone : r.audience === "everyone" || r.audience === "cohort" ? Hash : Lock;
              return (
                <tr key={r.id} className={r.archived ? "opacity-60" : ""}>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                      <Icon className="h-4 w-4 text-ink-faint" />
                      {r.name}
                      {r.archived ? <span className="rounded border border-line px-1 text-[10px] text-ink-faint">archived</span> : null}
                    </span>
                    {r.topic ? <span className="mt-0.5 block max-w-xs truncate text-xs text-ink-faint">{r.topic}</span> : null}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-soft">
                    {r.audienceLabel}
                    {r.members.length ? (
                      <button type="button" className="ml-1 link-ink" onClick={() => setMembersOf(r)}>
                        +{r.members.length}
                      </button>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-soft">
                    {r.posting === "staff" ? "Staff only" : "Everyone"}
                    {r.slowmodeSeconds ? ` · slow ${slowLabel(r.slowmodeSeconds)}` : ""}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-soft">{r.messageCount.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-xs text-ink-faint">
                    {r.lastMessageAt ? <LocalTime value={r.lastMessageAt} mode="datetime-short" /> : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-1">
                      <IconButton label="Edit" onClick={() => setEditing(r)}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton label="Members" onClick={() => setMembersOf(r)}>
                        <Users className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        label={r.archived ? "Unarchive" : "Archive"}
                        onClick={async () => {
                          const res = await setChannelArchived(r.id, !r.archived);
                          if (!res.ok) setError(resultError(res, "Couldn't do that."));
                          router.refresh();
                        }}
                      >
                        <Archive className="h-4 w-4" />
                      </IconButton>
                      {!r.system ? (
                        <IconButton label="Delete" onClick={() => setDeleting(r)}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing ? (
        <ChannelForm
          row={editing === "new" ? null : editing}
          cohorts={cohorts}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteChannel
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      ) : null}
      {membersOf ? (
        <Modal
          open
          title={`Extra members of #${membersOf.name}`}
          onClose={() => {
            setMembersOf(null);
            setRemoveError(null);
          }}
        >
          <p className="mb-3 text-xs text-ink-soft">
            People who see this channel on top of its audience. Add people from the channel&apos;s menu in{" "}
            <a className="link-ink" href={`/chat?c=${membersOf.id}`}>chat</a>.
          </p>
          {removeError ? <p className="mb-3 text-xs text-red-600 dark:text-red-400">{removeError}</p> : null}
          {membersOf.members.length === 0 ? (
            <p className="text-sm text-ink-faint">Nobody extra.</p>
          ) : (
            <ul className="divide-y divide-line">
              {membersOf.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="truncate text-ink">{m.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      setRemoveError(null);
                      const res = await removeChannelMember(membersOf.id, m.id);
                      if (!res.ok) {
                        // Shown in the modal: the page behind it is covered.
                        setRemoveError(resultError(res, "Couldn't remove them."));
                        return;
                      }
                      setMembersOf({ ...membersOf, members: membersOf.members.filter((x) => x.id !== m.id) });
                      router.refresh();
                    }}
                  >
                    <UserMinus className="h-4 w-4" />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      ) : null}
    </section>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-wash hover:text-ink"
    >
      {children}
    </button>
  );
}

function ChannelForm({
  row,
  cohorts,
  teams,
  onClose,
  onSaved,
}: {
  row: ChannelAdminRow | null;
  cohorts: Option[];
  teams: Option[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [topic, setTopic] = useState(row?.topic ?? "");
  const [audience, setAudience] = useState<Audience>(row?.audience ?? "everyone");
  const [cohortId, setCohortId] = useState(row?.cohortId ?? cohorts[0]?.id ?? "");
  const [teamId, setTeamId] = useState(row?.teamId ?? teams[0]?.id ?? "");
  const [posting, setPosting] = useState<Posting>(row?.posting ?? "everyone");
  const [slowmode, setSlowmode] = useState(row?.slowmodeSeconds ?? 0);
  const [position, setPosition] = useState(row?.position ?? 30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fixed = !!row?.system;

  const save = async () => {
    setBusy(true);
    setError(null);
    const input: ChannelInput = { name, topic, audience, cohortId, teamId, posting, slowmodeSeconds: slowmode, position };
    const res = row ? await updateChannel(row.id, input) : await createChannel(input);
    setBusy(false);
    if (!res.ok) setError(resultError(res, "Couldn't save the channel."));
    else onSaved();
  };

  return (
    <Modal open title={row ? `Edit #${row.name}` : "New channel"} onClose={onClose} busy={busy} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-ink-soft sm:col-span-2">
          Name
          <div className="relative mt-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">#</span>
            <input
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setName(normalizeChannelName(name))}
              placeholder="pitch-feedback"
              className={`${field} pl-7`}
            />
          </div>
        </label>
        <label className="block text-xs font-medium text-ink-soft sm:col-span-2">
          Topic
          <input value={topic} onChange={(e) => setTopic(e.target.value.slice(0, TOPIC_MAX))} placeholder="What this channel is for" className={`${field} mt-1`} />
        </label>
        <label className="block text-xs font-medium text-ink-soft sm:col-span-2">
          Who can see it
          <select value={audience} disabled={fixed} onChange={(e) => setAudience(e.target.value as Audience)} className={`${field} mt-1`}>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>
            ))}
          </select>
          {fixed ? <span className="mt-1 block text-[11px] text-ink-faint">batch0 made this channel, so who sees it is fixed.</span> : null}
        </label>
        {audience === "cohort" ? (
          <label className="block text-xs font-medium text-ink-soft sm:col-span-2">
            Cohort
            <select value={cohortId} disabled={fixed} onChange={(e) => setCohortId(e.target.value)} className={`${field} mt-1`}>
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        ) : null}
        {audience === "team" ? (
          <label className="block text-xs font-medium text-ink-soft sm:col-span-2">
            Team
            <select value={teamId} disabled={fixed} onChange={(e) => setTeamId(e.target.value)} className={`${field} mt-1`}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block text-xs font-medium text-ink-soft">
          Who can post
          <select value={posting} onChange={(e) => setPosting(e.target.value as Posting)} className={`${field} mt-1`}>
            <option value="everyone">Everyone who sees it</option>
            <option value="staff">Only staff (read-only)</option>
          </select>
        </label>
        <label className="block text-xs font-medium text-ink-soft">
          Slow mode
          <select value={slowmode} onChange={(e) => setSlowmode(Number(e.target.value))} className={`${field} mt-1`}>
            {SLOWMODE_CHOICES.map((s) => (
              <option key={s} value={s}>{slowLabel(s)}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-ink-soft">
          Position
          <input type="number" value={position} onChange={(e) => setPosition(Number(e.target.value))} className={`${field} mt-1`} />
        </label>
      </div>
      {audience === "members" ? (
        <p className="mt-3 text-[11px] text-ink-faint">After saving, open the channel in chat and use “Add people”.</p>
      ) : null}
      {error ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={save} disabled={busy || !name.trim()}>{row ? "Save" : "Create channel"}</Button>
      </div>
    </Modal>
  );
}

function DeleteChannel({ row, onClose, onDone }: { row: ChannelAdminRow; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open title={`Delete #${row.name}?`} onClose={onClose} busy={busy}>
      <p className="text-sm text-ink-soft">
        This deletes the channel and all {row.messageCount.toLocaleString()} messages in it, for good. Archiving keeps the
        history read-only instead.
      </p>
      <label className="mt-3 block text-xs font-medium text-ink-soft">
        Type <strong className="text-ink">{row.name}</strong> to confirm
        <input data-autofocus value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`${field} mt-1`} />
      </label>
      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="danger"
          disabled={busy || confirm.trim() !== row.name}
          onClick={async () => {
            setBusy(true);
            const res = await deleteChannel(row.id, confirm);
            setBusy(false);
            if (!res.ok) setError(resultError(res, "Couldn't delete the channel."));
            else onDone();
          }}
        >
          Delete forever
        </Button>
      </div>
    </Modal>
  );
}
