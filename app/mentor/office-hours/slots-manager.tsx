"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError, Textarea } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { createSlot, deleteSlot, cancelBooking } from "./actions";
import { Trash2, Video, X } from "lucide-react";
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
        <h3 className="text-base font-semibold">New slot</h3>
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
        <h3 className="px-5 pt-5 text-base font-semibold">
          Upcoming + recent
        </h3>
        <ul className="mt-3 divide-y divide-white/5">
          {slots.length === 0 && (
            <li className="px-5 py-6 text-sm text-white/40">
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
                className="flex items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    <LocalTime value={s.starts_at} /> ·{" "}
                    <span className="text-white/40">
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
                      className="mt-0.5 inline-flex items-center gap-1 text-xs text-spark hover:underline"
                    >
                      <Video className="h-3 w-3" /> Join
                    </a>
                  )}
                  {s.booking ? (
                    <div className="mt-1 text-xs text-emerald-300">
                      Booked by {student?.full_name ?? student?.email}
                      {s.booking.topic && (
                        <span className="text-white/55">
                          {" "}
                          · "{s.booking.topic.slice(0, 60)}"
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-white/40">
                      {isPast ? "Past, unclaimed" : "Open"}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {s.booking && (
                    <button
                      onClick={() => cancel(s.booking.id)}
                      className="p-1.5 text-white/40 hover:text-amber-300"
                      title="Cancel booking"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  {!s.booking && (
                    <button
                      onClick={() => remove(s.id)}
                      className="p-1.5 text-white/40 hover:text-red-400"
                      title="Delete slot"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
