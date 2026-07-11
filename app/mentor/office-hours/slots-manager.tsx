"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError, Textarea } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import {
  createSlot,
  deleteSlot,
  cancelBooking,
  saveBookingRecap,
} from "./actions";
import { Trash2, Video, X, MessageSquare, CheckCircle2 } from "lucide-react";
import { getActionError } from "@/lib/action-error";

export function SlotsManager({ slots }: { slots: any[] }) {
  const router = useRouter();
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [zoom, setZoom] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function add() {
    setErr(undefined);
    start(async () => {
      try {
        await createSlot({
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(ends).toISOString(),
          zoomUrl: zoom || undefined,
          notes: notes || undefined,
        });
        setStarts("");
        setEnds("");
        setZoom("");
        setNotes("");
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      try {
        await deleteSlot({ slotId: id });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function cancel(id: string) {
    start(async () => {
      try {
        await cancelBooking({ bookingId: id });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">New slot</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Starts</Label>
            <Input
              type="datetime-local"
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
          </div>
          <div>
            <Label>Ends</Label>
            <Input
              type="datetime-local"
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Zoom URL</Label>
            <Input
              value={zoom}
              onChange={(e) => setZoom(e.target.value)}
              placeholder="https://zoom.us/j/..."
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              maxLength={280}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What you're best at advising on this slot"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <FieldError>{err}</FieldError>
          <Button onClick={add} disabled={pending || !starts || !ends}>
            {pending ? "Saving…" : "Publish slot"}
          </Button>
        </div>
      </Card>

      <Card className="!p-0">
        <h3 className="px-5 pt-5 font-display text-base font-semibold tracking-[-0.02em] text-ink">
          Upcoming + recent
        </h3>
        <ul className="mt-3 divide-y divide-line">
          {slots.length === 0 && (
            <li className="px-5 py-6 text-sm text-ink-faint">
              No slots yet.
            </li>
          )}
          {slots.map((s: any) => {
            const isPast = new Date(s.starts_at).getTime() < Date.now();
            const student = s.booking
              ? Array.isArray(s.booking.student)
                ? s.booking.student[0]
                : s.booking.student
              : null;
            return (
              <li
                key={s.id}
                className="flex flex-col gap-3 px-5 py-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">
                      <LocalTime value={s.starts_at} /> ·{" "}
                      <span className="text-ink-faint">
                        {Math.round(
                          (new Date(s.ends_at).getTime() -
                            new Date(s.starts_at).getTime()) /
                            60000,
                        )}
                        m
                      </span>
                    </div>
                    {s.zoom_url && (
                      <a
                        href={s.zoom_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex items-center gap-1 text-xs text-spark-ink hover:underline"
                      >
                        <Video className="h-3 w-3" /> Join
                      </a>
                    )}
                    {s.booking ? (
                      <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                        Booked by {student?.full_name ?? student?.email}
                        {s.booking.topic && (
                          <span className="text-ink-soft">
                            {" "}
                            · "{s.booking.topic.slice(0, 60)}"
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-ink-faint">
                        {isPast ? "Past, unclaimed" : "Open"}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {s.booking && (
                      <button
                        onClick={() => cancel(s.booking.id)}
                        className="p-1.5 text-ink-faint hover:text-amber-700 dark:hover:text-amber-300"
                        title="Cancel booking"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    {!s.booking && (
                      <button
                        onClick={() => remove(s.id)}
                        className="p-1.5 text-ink-faint hover:text-red-700 dark:hover:text-red-300"
                        title="Delete slot"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                {s.booking && isPast && (
                  <RecapEditor
                    bookingId={s.booking.id}
                    initial={s.booking.recap_notes ?? ""}
                    postedAt={s.booking.recap_posted_at ?? null}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function RecapEditor({
  bookingId,
  initial,
  postedAt,
}: {
  bookingId: string;
  initial: string;
  postedAt: string | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initial);
  const [editing, setEditing] = useState(!initial);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function save() {
    setErr(undefined);
    start(async () => {
      try {
        await saveBookingRecap({ bookingId, body });
        setEditing(false);
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  if (!editing && initial) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <span className="inline-flex items-center gap-1 font-mono text-xs font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" />
            Recap posted
            {postedAt && (
              <span className="ml-1 normal-case tracking-normal text-emerald-700/70 dark:text-emerald-200/60">
                · <LocalTime value={postedAt} mode="datetime-short" />
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-ink-soft hover:text-ink"
          >
            Edit
          </button>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-soft">
          {initial}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-wash px-3 py-2">
      <Label htmlFor={`recap-${bookingId}`}>
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          Session recap (visible to the student)
        </span>
      </Label>
      <Textarea
        id={`recap-${bookingId}`}
        rows={3}
        maxLength={4000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What you covered, action items, links — anything the student should walk away with."
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <FieldError>{err}</FieldError>
        <div className="ml-auto flex gap-2">
          {initial && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setBody(initial);
                setEditing(false);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : initial ? "Update recap" : "Post recap"}
          </Button>
        </div>
      </div>
    </div>
  );
}
