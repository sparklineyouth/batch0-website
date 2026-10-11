"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { Search, Check, X } from "lucide-react";
import { MAX_CALL_COHOSTS } from "@/lib/live";

export type InviteeOption = {
  id: string;
  name: string;
  email: string;
  teamName?: string | null;
};

export type InviteDraft = {
  inviteeId: string;
  startsAt: string;
  durationMinutes: number;
  topic: string;
  /** Others from the team joining the call (migration 0092). */
  cohostIds: string[];
};

const DURATIONS = [15, 20, 30, 45, 60];

/**
 * "Invite a student to a 1:1."
 *
 * The inverse of office hours: there, a mentor posts open slots and a student
 * claims one; here the host picks the person and proposes a time. Both will
 * coexist — a student who wants time asks for a slot, a mentor or investor who
 * wants time sends an invite.
 *
 * The picker lists every student the host is allowed to invite, unfiltered by
 * assignment. That is a deliberate product choice and worth remembering: it
 * means an investor can reach a student they have no prior connection to, so
 * the audit trail on the resulting invite is the safeguard rather than the
 * picker itself.
 *
 * Still one student, but the host can bring anyone from the team along
 * ("Also joining") — a 1:1 is one student and any number of staff.
 */
export function InviteForm({
  students,
  staff = [],
  onSubmit,
  onCancel,
  pending = false,
  error,
}: {
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
  const [startsLocal, setStartsLocal] = useState(defaultStart());
  const [duration, setDuration] = useState(30);
  const [topic, setTopic] = useState("");
  const [cohostIds, setCohostIds] = useState<string[]>([]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? students.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.email.toLowerCase().includes(q) ||
            (s.teamName ?? "").toLowerCase().includes(q),
        )
      : students;
    // Cap the list rather than rendering the whole directory — the search box
    // is the way to reach someone further down.
    return list.slice(0, 8);
  }, [students, query]);

  const selected = students.find((s) => s.id === inviteeId) ?? null;
  const valid = !!inviteeId && !!startsLocal;

  return (
    <div className="space-y-4">
      <div>
        <Label>Who</Label>
        {selected ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-wash px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">
                {selected.name}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {selected.email}
                {selected.teamName ? ` · ${selected.teamName}` : ""}
              </p>
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
                placeholder="Search students by name, email, or team"
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
                      <span className="block truncate text-sm text-ink">
                        {s.name}
                      </span>
                      <span className="block truncate text-xs text-ink-faint">
                        {s.email}
                        {s.teamName ? ` · ${s.teamName}` : ""}
                      </span>
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>When</Label>
          <Input
            type="datetime-local"
            value={startsLocal}
            onChange={(e) => setStartsLocal(e.target.value)}
          />
        </div>
        <div>
          <Label>How long</Label>
          <Select
            value={String(duration)}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <Label>What it&rsquo;s about (optional)</Label>
        <Textarea
          rows={2}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Fundraising questions, product feedback, a portfolio review…"
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          They&rsquo;ll see this in the invite email and can accept or decline.
        </p>
      </div>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex gap-2 pt-1">
        <Button
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              inviteeId: inviteeId!,
              startsAt: new Date(startsLocal).toISOString(),
              durationMinutes: duration,
              topic: topic.trim(),
              cohostIds,
            })
          }
        >
          {pending ? "Sending…" : "Send invite"}
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

/**
 * "Also joining (optional)": search the team, add people as removable chips.
 *
 * Shared by the invite form and the team's call-request queue, so both ways
 * of booking a 1:1 put people on it the same way. Search-first rather than a
 * list, like the student picker, because the team is a directory. Renders
 * nothing when there is nobody to add. Stops at MAX_CALL_COHOSTS, the same
 * number the server refuses past, so the limit is met here rather than as
 * an error after Send.
 */
export function CohostPicker({
  staff,
  value,
  onChange,
}: {
  staff: InviteeOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const full = value.length >= MAX_CALL_COHOSTS;
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
      <Label>Also joining (optional)</Label>
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
          placeholder={
            full
              ? `That's the most — ${MAX_CALL_COHOSTS} from the team`
              : "Add people from the team"
          }
          disabled={full}
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
      <p className="mt-1.5 text-xs text-ink-faint">
        Still one student. Add up to {MAX_CALL_COHOSTS} from the team — a
        handful works best, because everyone&rsquo;s video goes to everyone.
        They can join, end or cancel the call, and watch it back.
      </p>
    </div>
  );
}

/** Tomorrow at the next round hour — a sane default that is never in the past. */
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
