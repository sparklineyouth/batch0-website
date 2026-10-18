"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Drawer } from "@/components/assignments/drawer";
import { getActionError } from "@/lib/action-error";
import { addDays } from "@/lib/assignments";
import {
  FOLLOWUP_GUIDANCE,
  FOLLOWUP_MAX_DAYS_AHEAD,
  FOLLOWUP_NOTE_MAX,
  defaultNextCheck,
  followUpDueLabel,
  followUpOwnerChoice,
  formatCheckDate,
  type FollowUpView,
} from "@/lib/student-followups";
import { closeFollowUp, loadFollowUp, saveFollowUp, type FollowUpDrawerData } from "./actions";

/** What the roster shows for a student's open follow-up, worked out on the server. */
export type FollowUpSummary = {
  ownerName: string | null;
  ownerIsViewer: boolean;
  nextCheckOn: string;
  /** "Due today", "In 4 days", … against today in New York. */
  dueLabel: string;
  due: boolean;
};

/**
 * A student's follow-up: who owns the check, when they'll look again, and a
 * factual note — opened from the roster, the "Follow-ups due" list, or a
 * deep link from the Overview's attention list (`?followup=<student id>`).
 * Loads what it shows when it opens, so the roster stays one cheap query.
 */
export function FollowUpButton({
  studentId,
  studentName,
  summary,
  canEdit,
  defaultOpen = false,
  hideTrigger = false,
}: {
  studentId: string;
  studentName: string;
  summary: FollowUpSummary | null;
  canEdit: boolean;
  defaultOpen?: boolean;
  /** Just the drawer — for a deep link to a student who isn't in this roster. */
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // After mount, not as the initial state: the drawer is a portal the server
  // never renders, so it must not appear on the hydrating pass.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const owner = summary ? (summary.ownerIsViewer ? "You" : (summary.ownerName ?? "No owner")) : null;
  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press rounded text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor"
          aria-label={`Follow-up for ${studentName}`}
        >
          {summary ? (
            <>
              <span className="block font-medium text-ink">{owner}</span>
              <span className={summary.due ? "text-amber-700 dark:text-amber-300" : "text-ink-faint"}>
                {summary.dueLabel}
              </span>
            </>
          ) : (
            <span className="text-ink-faint hover:text-ink">{canEdit ? "Add" : "None"}</span>
          )}
        </button>
      )}
      <Drawer open={open} title={`Follow-up · ${studentName}`} onClose={() => setOpen(false)}>
        {open && <FollowUpPanel studentId={studentId} />}
      </Drawer>
    </>
  );
}

function FollowUpPanel({ studentId }: { studentId: string }) {
  const router = useRouter();
  const [data, setData] = useState<FollowUpDrawerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    loadFollowUp(studentId)
      .then((res) => {
        if (!live) return;
        if (res.ok && res.data) {
          setData(res.data);
          setError(null);
        } else if (!res.ok) setError(res.error);
      })
      .catch((e) => {
        if (live) setError(getActionError(e));
      });
    return () => {
      live = false;
    };
  }, [studentId, version]);

  if (!data) return error ? <FieldError>{error}</FieldError> : <p className="text-sm text-ink-faint">Loading…</p>;
  return (
    <FollowUpDetails
      data={data}
      onChanged={() => {
        setVersion((v) => v + 1);
        router.refresh();
      }}
    />
  );
}

/** The drawer's contents for loaded data — what /dev/attention previews. */
export function FollowUpDetails({ data, onChanged }: { data: FollowUpDrawerData; onChanged: () => void }) {
  if (!data.ready) return <p className="text-sm text-ink-soft">Follow-ups aren&apos;t set up yet.</p>;

  return (
    <div className="space-y-6">
      {data.active ? (
        <ActiveFollowUp followUp={data.active} viewerId={data.viewerId} today={data.today} />
      ) : (
        <p className="text-sm text-ink-soft">Nobody is following up with {data.student.name} right now.</p>
      )}

      {data.canEdit ? (
        <>
          <FollowUpForm key={data.active?.updatedAt ?? "new"} data={data} onSaved={onChanged} />
          {data.active && <CloseForm key={`close:${data.active.updatedAt}`} followUp={data.active} onClosed={onChanged} />}
        </>
      ) : (
        <p className="text-xs text-ink-faint">Read-only. Changing follow-ups needs &ldquo;Manage people&rdquo;.</p>
      )}

      {data.history.length > 0 && <History items={data.history} />}
    </div>
  );
}

function ActiveFollowUp({ followUp, viewerId, today }: { followUp: FollowUpView; viewerId: string; today: string }) {
  const owner = followUp.ownerId === viewerId ? "You" : (followUp.ownerName ?? "No owner");
  return (
    <div className="rounded-md border border-line bg-wash px-4 py-3">
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-faint">Owner</dt>
        <dd className="text-ink">{owner}</dd>
        <dt className="text-ink-faint">Next check</dt>
        <dd className="text-ink">
          {formatCheckDate(followUp.nextCheckOn)}{" "}
          <span className="text-ink-faint">· {followUpDueLabel(followUp.nextCheckOn, today)}</span>
        </dd>
      </dl>
      <p className="mt-3 whitespace-pre-wrap text-sm text-ink">{followUp.note}</p>
      <p className="mt-2 text-xs text-ink-faint">
        Started{followUp.createdByName ? ` by ${followUp.createdByName}` : ""}{" "}
        <LocalTime value={followUp.createdAt} mode="date" />
      </p>
    </div>
  );
}

function FollowUpForm({ data, onSaved }: { data: FollowUpDrawerData; onSaved: () => void }) {
  const active = data.active;
  // Only people who can own follow-ups are offered — the server refuses
  // anyone else — so an owner whose role changed isn't preselected; the
  // line under the picker says who needs replacing.
  const choice = followUpOwnerChoice(active, data.owners, data.viewerId);
  const [ownerId, setOwnerId] = useState(choice.initialOwnerId);
  const [nextCheckOn, setNextCheckOn] = useState(defaultNextCheck(active, data.today));
  const [note, setNote] = useState(active?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const owners = data.owners;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        const res = await saveFollowUp({
          studentId: data.student.id,
          followUpId: active?.id ?? null,
          expectedUpdatedAt: active?.updatedAt ?? null,
          ownerId,
          nextCheckOn,
          note,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onSaved();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h3 className="font-mono text-xs uppercase tracking-wider text-ink-faint">
        {active ? "Update" : "Start a follow-up"}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="followup-owner" required>
            Owner
          </Label>
          <Select
            id="followup-owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            aria-describedby={choice.staleOwnerName ? "followup-owner-hint" : undefined}
            required
          >
            <option value="" disabled>
              Pick someone
            </option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id === data.viewerId ? `${o.name} (you)` : o.name}
              </option>
            ))}
          </Select>
          {choice.staleOwnerName && (
            <p id="followup-owner-hint" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {choice.staleOwnerName} can no longer own follow-ups. Pick who takes it over to save.
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="followup-date" required>
            Next check
          </Label>
          <Input
            id="followup-date"
            type="date"
            value={nextCheckOn}
            min={data.today}
            max={addDays(data.today, FOLLOWUP_MAX_DAYS_AHEAD)}
            onChange={(e) => setNextCheckOn(e.target.value)}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="followup-note" required>
          Note
        </Label>
        <Textarea
          id="followup-note"
          rows={4}
          maxLength={FOLLOWUP_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. No weekly update for weeks 3 and 4. Emailed Tuesday; will check the week 5 update."
          aria-describedby="followup-note-hint"
          required
        />
        <p id="followup-note-hint" className="mt-1 text-xs text-ink-faint">
          {FOLLOWUP_GUIDANCE}
        </p>
      </div>
      <FieldError>{error}</FieldError>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || !ownerId}>
          {pending ? "Saving…" : active ? "Save" : "Start follow-up"}
        </Button>
      </div>
    </form>
  );
}

function CloseForm({ followUp, onClosed }: { followUp: FollowUpView; onClosed: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function close() {
    setError(null);
    start(async () => {
      try {
        const res = await closeFollowUp({
          followUpId: followUp.id,
          expectedUpdatedAt: followUp.updatedAt,
          closingNote: note,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onClosed();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <Label htmlFor="followup-closing">How it ended (optional)</Label>
      <Textarea
        id="followup-closing"
        rows={2}
        maxLength={FOLLOWUP_NOTE_MAX}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Week 5 update handed in."
      />
      <FieldError>{error}</FieldError>
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" disabled={pending} onClick={close}>
          {pending ? "Closing…" : "Close follow-up"}
        </Button>
      </div>
    </div>
  );
}

function History({ items }: { items: FollowUpView[] }) {
  return (
    <section className="border-t border-line pt-4">
      <h3 className="font-mono text-xs uppercase tracking-wider text-ink-faint">Earlier follow-ups</h3>
      <ul className="mt-3 space-y-3">
        {items.map((f) => (
          <li key={f.id} className="text-sm">
            <p className="text-xs text-ink-faint">
              <LocalTime value={f.createdAt} mode="date" />
              {f.closedAt && (
                <>
                  {" – "}
                  <LocalTime value={f.closedAt} mode="date" />
                </>
              )}
              {` · ${f.ownerName ?? "No owner"}`}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-ink-soft">{f.note}</p>
            {f.closingNote && (
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-ink-faint">
                Closed{f.closedByName ? ` by ${f.closedByName}` : ""}: {f.closingNote}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
