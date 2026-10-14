"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { Search, Check, X } from "lucide-react";
import { getActionError } from "@/lib/action-error";
import { updateInvite } from "@/app/calls/actions";
import { MAX_CALL_COHOSTS, type CallInvite } from "@/lib/live";

export type InviteeOption = {
  id: string;
  name: string;
  email: string;
  teamName?: string | null;
};

export type InviteDraft = {
  inviteeId: string;
  /** Absent when starting now: the server starts it on the current minute. */
  startsAt?: string;
  startNow: boolean;
  durationMinutes: number;
  topic: string;
  /** Others from the team joining the call (migration 0092). */
  cohostIds: string[];
};

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];

/**
 * Book a 1:1 with a student, or start one now. One student; anyone from the
 * team can come along ("Also joining"). The picker lists every student the
 * host may invite — the audit trail, not the picker, is the safeguard.
 */
export function InviteForm({
  mode,
  students,
  staff = [],
  onSubmit,
  onCancel,
  pending = false,
  error,
}: {
  mode: "now" | "schedule";
  students: InviteeOption[];
  /** Who can be added alongside the host. The page has already left the host out. */
  staff?: InviteeOption[];
  onSubmit: (draft: InviteDraft) => void;
  onCancel?: () => void;
  pending?: boolean;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const [inviteeId, setInviteeId] = useState<string | null>(null);
  const [startsLocal, setStartsLocal] = useState(defaultStart);
  const [duration, setDuration] = useState(30);
  const [topic, setTopic] = useState("");
  const [cohostIds, setCohostIds] = useState<string[]>([]);
  const now = mode === "now";

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? students.filter(
          (s) => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q),
        )
      : students;
    return list.slice(0, 8);
  }, [students, query]);

  const selected = students.find((s) => s.id === inviteeId) ?? null;
  const valid = !!inviteeId && (now || !!startsLocal);

  return (
    <div className="space-y-4">
      <div>
        <Label>Student</Label>
        {selected ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-wash px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{selected.name}</p>
              <p className="truncate text-xs text-ink-faint">{selected.email}</p>
            </div>
            <button
              type="button"
              onClick={() => setInviteeId(null)}
              className="shrink-0 text-xs text-phosphor-ink underline underline-offset-2"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search students"
                aria-label="Search students"
                className="pl-9"
              />
            </div>
            <ul className="mt-2 max-h-56 overflow-y-auto rounded-md border border-line">
              {matches.length === 0 && (
                <li className="px-3 py-3 text-sm text-ink-faint">
                  No students match &ldquo;{query}&rdquo;.
                </li>
              )}
              {matches.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setInviteeId(s.id);
                      setQuery("");
                    }}
                    className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-wash"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{s.name}</span>
                      <span className="block truncate text-xs text-ink-faint">{s.email}</span>
                    </span>
                    <Check className="h-4 w-4 shrink-0 text-ink-faint opacity-0" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <CohostPicker staff={staff} value={cohostIds} onChange={setCohostIds} />

      <CallTimeFields
        withTime={!now}
        startsLocal={startsLocal}
        onStartsLocal={setStartsLocal}
        duration={duration}
        onDuration={setDuration}
      />

      <div>
        <Label>Topic (optional)</Label>
        <Textarea rows={2} value={topic} onChange={(e) => setTopic(e.target.value)} />
      </div>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex gap-2 pt-1">
        <Button
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              inviteeId: inviteeId!,
              startsAt: now ? undefined : new Date(startsLocal).toISOString(),
              startNow: now,
              durationMinutes: duration,
              topic: topic.trim(),
              cohostIds,
            })
          }
        >
          {now ? (pending ? "Starting…" : "Start call") : pending ? "Booking…" : "Book call"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/** When + how long, shared by booking and editing. */
function CallTimeFields({
  withTime,
  startsLocal,
  onStartsLocal,
  duration,
  onDuration,
}: {
  withTime: boolean;
  startsLocal: string;
  onStartsLocal: (v: string) => void;
  duration: number;
  onDuration: (v: number) => void;
}) {
  const options = DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {withTime && (
        <div>
          <Label>When</Label>
          <Input
            type="datetime-local"
            value={startsLocal}
            onChange={(e) => onStartsLocal(e.target.value)}
          />
        </div>
      )}
      <div>
        <Label>How long</Label>
        <Select value={String(duration)} onChange={(e) => onDuration(Number(e.target.value))}>
          {options.map((d) => (
            <option key={d} value={d}>
              {d} minutes
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/**
 * Move a booked call, change its length or topic (updateInvite). The student
 * is told; a new time can be declined.
 */
export function EditCallForm({
  invite,
  onClose,
}: {
  invite: Pick<CallInvite, "id" | "startsAt" | "durationMinutes" | "topic">;
  onClose: () => void;
}) {
  const router = useRouter();
  const [startsLocal, setStartsLocal] = useState(() => toLocalInput(invite.startsAt));
  const [duration, setDuration] = useState(invite.durationMinutes);
  const [topic, setTopic] = useState(invite.topic ?? "");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const inFlight = useRef(false);

  function save() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    start(async () => {
      try {
        const result = await updateInvite({
          id: invite.id,
          startsAt: new Date(startsLocal).toISOString(),
          durationMinutes: duration,
          topic,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
        onClose();
      } catch (err: any) {
        setError(getActionError(err));
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <CallTimeFields
        withTime
        startsLocal={startsLocal}
        onStartsLocal={setStartsLocal}
        duration={duration}
        onDuration={setDuration}
      />
      <div>
        <Label>Topic (optional)</Label>
        <Input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </div>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !startsLocal} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * "Also joining": search the team, add people as removable chips. Shared by
 * booking, the request queue and Add people, so everyone lands on a call the
 * same way. Stops at MAX_CALL_COHOSTS, counting co-hosts the call already has.
 */
export function CohostPicker({
  staff,
  value,
  onChange,
  label = "Also joining (optional)",
  already = 0,
  autoFocus = false,
}: {
  staff: InviteeOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  /** Co-hosts the call already has. They count toward MAX_CALL_COHOSTS. */
  already?: number;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const full = already + value.length >= MAX_CALL_COHOSTS;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || full) return [];
    return staff
      .filter((s) => !value.includes(s.id))
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.email.toLowerCase().includes(q) ||
          (s.teamName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [staff, query, value, full]);
  const chosen = value
    .map((id) => staff.find((s) => s.id === id))
    .filter((s): s is InviteeOption => !!s);

  if (staff.length === 0) return null;

  return (
    <div>
      <Label>{label}</Label>
      {chosen.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {chosen.map((c) => (
            <li
              key={c.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-wash py-1 pl-3 pr-1.5 text-xs text-ink"
            >
              <span className="truncate">{c.name}</span>
              {c.teamName && (
                <span className="font-mono uppercase tracking-wider text-ink-faint">
                  {c.teamName}
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${c.name}`}
                onClick={() => onChange(value.filter((id) => id !== c.id))}
                className="shrink-0 rounded-full p-0.5 text-ink-faint hover:bg-line hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <Input
          value={full ? "" : query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={full ? `That's the most (${MAX_CALL_COHOSTS})` : "Add people from the team"}
          aria-label={label}
          disabled={full}
          autoFocus={autoFocus}
          className="pl-9"
        />
      </div>
      {query.trim() && !full && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line">
          {matches.length === 0 && (
            <li className="px-3 py-3 text-sm text-ink-faint">
              Nobody on the team matches &ldquo;{query}&rdquo;.
            </li>
          )}
          {matches.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...value, s.id]);
                  setQuery("");
                }}
                className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-wash"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{s.name}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {s.email}
                    {s.teamName ? ` · ${s.teamName}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An ISO instant as a datetime-local value in the viewer's zone. */
export function toLocalInput(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next round hour (at least 15 minutes away), as a datetime-local value. */
export function defaultStart(): string {
  const d = new Date(Date.now() + 15 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d);
}
