"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { LiveDot } from "@/components/live/live-dot";
import { getActionError } from "@/lib/action-error";
import { EVENT_TYPE_LABEL, httpsUrl, whoFromRow } from "@/lib/event-form";
import { joinNames } from "@/lib/live";
import { deleteEvent } from "./actions";
import { EventForm } from "./event-form";
import { LiveControls } from "./live-controls";
import { StartNowButton } from "./start-now";
import type { AdminEventRow, CohortOption } from "./types";
import { ExternalLink, Pencil, Plus, Trash2, Video } from "lucide-react";

const PAST_SHOWN = 15;

export function EventsAdmin({
  rows,
  cohorts,
  defaultCohortId,
  now,
  initialEditId,
}: {
  rows: AdminEventRow[];
  cohorts: CohortOption[];
  defaultCohortId: string | null;
  /** ISO; the server's clock, so rows agree with their section. */
  now: string;
  /** `?edit=<id>` or `?edit=new`. */
  initialEditId: string | null;
}) {
  const router = useRouter();
  // The form renders only after mount: its datetime-local default is in the
  // browser's zone, which the server can't know.
  const [mounted, setMounted] = useState(false);
  const [editing, setEditing] = useState<AdminEventRow | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminEventRow | null>(null);
  const [showAllPast, setShowAllPast] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    setMounted(true);
    if (initialEditId === "new") setEditing("new");
    else if (initialEditId) setEditing(rows.find((r) => r.id === initialEditId) ?? null);
    // Only the first render's deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeEditor() {
    setEditing(null);
    if (initialEditId) router.replace("/admin/events", { scroll: false });
  }

  function remove() {
    const row = confirmDelete;
    if (!row) return;
    setError(null);
    start(async () => {
      try {
        const r = await deleteEvent(row.id);
        if (!r.ok) throw new Error(r.error);
        setConfirmDelete(null);
        router.refresh();
      } catch (err) {
        setConfirmDelete(null);
        setError(getActionError(err));
      }
    });
  }

  const live = rows.filter((r) => r.group === "live");
  const upcoming = rows
    .filter((r) => r.group === "upcoming")
    .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
  const past = rows.filter((r) => r.group === "past");
  const pastShown = showAllPast ? past : past.slice(0, PAST_SHOWN);

  if (mounted && editing) {
    return (
      <div className="rounded-md border border-line p-4 sm:p-6">
        <EventForm
          key={editing === "new" ? "new" : editing.id}
          event={editing === "new" ? null : editing}
          cohorts={cohorts}
          defaultCohortId={defaultCohortId}
          onDone={() => {
            closeEditor();
            router.refresh();
          }}
        />
      </div>
    );
  }

  const row = (r: AdminEventRow) => (
    <EventRow
      key={r.id}
      row={r}
      now={now}
      onEdit={() => setEditing(r)}
      onDelete={() => setConfirmDelete(r)}
    />
  );

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <StartNowButton
          cohorts={cohorts}
          defaultCohortId={defaultCohortId}
          live={live
            .filter((r) => r.liveMode === "hosted")
            .map((r) => ({
              id: r.id,
              title: r.title,
              who: whoFromRow({ visibility: r.visibility, cohort_id: r.cohortId }, null),
              hosting: r.hosting,
            }))}
        />
        <Button variant="secondary" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> New event
        </Button>
      </div>

      {error && <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>}

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-ink-faint">No events yet.</p>
      ) : (
        <div className="mt-8 space-y-10">
          {live.length > 0 && <Section label="Live now">{live.map(row)}</Section>}
          <Section label="Upcoming">
            {upcoming.length ? upcoming.map(row) : <Empty>Nothing scheduled.</Empty>}
          </Section>
          {past.length > 0 && (
            <Section label="Past">
              {pastShown.map(row)}
              {past.length > pastShown.length && (
                <button
                  type="button"
                  onClick={() => setShowAllPast(true)}
                  className="py-3 text-sm text-phosphor-ink hover:underline"
                >
                  Show {past.length - pastShown.length} more
                </button>
              )}
            </Section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this event?"
        description={
          <p>
            {confirmDelete?.title} and everything attached to it — attendance, chat,
            slides, recordings — are deleted.
          </p>
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={remove}
        onCancel={() => !pending && setConfirmDelete(null)}
      />
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl text-ink">{label}</h2>
      <div className="mt-2 border-t border-line">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-sm text-ink-faint">{children}</p>;
}

function audienceLabel(r: AdminEventRow): string {
  if (r.visibility === "staff") return "Staff only";
  if (r.visibility === "public") return "Everyone";
  return r.cohortName ?? "Cohort";
}

function EventRow({
  row: r,
  now,
  onEdit,
  onDelete,
}: {
  row: AdminEventRow;
  now: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hosted = r.liveMode === "hosted";
  // An href, so through httpsUrl like every other reader (lib/event-form.ts).
  const externalHref = httpsUrl(r.externalUrl);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/admin/events/${r.id}`} className="text-sm font-semibold text-ink hover:underline">
            {r.title}
          </Link>
          {r.group === "live" && <LiveDot />}
          {r.liveEndedAt && <Chip>Ended</Chip>}
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-faint">
          <LocalTime value={r.startsAt} mode="datetime-short" />
          <span>{EVENT_TYPE_LABEL[r.type]}</span>
          <span>{audienceLabel(r)}</span>
          {!hosted && <span>External</span>}
          {r.hosting.length > 0 && (
            <span className="text-phosphor-ink">{joinNames(r.hosting)} hosting</span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hosted && r.roomAction && (
          <ButtonLink
            size="sm"
            variant={r.group === "live" ? "primary" : "secondary"}
            href={`/dashboard/events/${r.id}/live`}
          >
            <Video className="h-4 w-4" />
            {r.roomAction}
          </ButtonLink>
        )}
        {!hosted && externalHref && r.group !== "past" && (
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-phosphor-ink hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Link
          </a>
        )}
        {r.group === "past" && r.hasRecording && (
          <Link href={`/admin/events/${r.id}#recording`} className="text-xs text-phosphor-ink hover:underline">
            Recording
          </Link>
        )}
        {hosted && (
          <LiveControls
            eventId={r.id}
            startsAt={r.startsAt}
            endsAt={r.endsAt}
            liveStartedAt={r.liveStartedAt}
            liveEndedAt={r.liveEndedAt}
            now={now}
          />
        )}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md p-1.5 text-ink-faint hover:text-ink"
          aria-label={`Edit ${r.title}`}
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-ink-faint hover:text-red-600 dark:hover:text-red-400"
          aria-label={`Delete ${r.title}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
      {children}
    </span>
  );
}
