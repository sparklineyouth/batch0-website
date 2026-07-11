"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Video, CheckCircle2 } from "lucide-react";
import { bookSlot, cancelBooking } from "@/app/mentor/office-hours/actions";
import { getActionError } from "@/lib/action-error";

export function SlotsList({ slots }: { slots: any[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [active, setActive] = useState<string | null>(null);
  const [topic, setTopic] = useState("");

  function book(id: string) {
    setErr(undefined);
    start(async () => {
      try {
        await bookSlot({ slotId: id, topic });
        setActive(null);
        setTopic("");
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function release(bookingId: string) {
    start(async () => {
      try {
        await cancelBooking({ bookingId });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-3">
      <FieldError>{err}</FieldError>
      {slots.map((s) => {
        const mentor = Array.isArray(s.mentor) ? s.mentor[0] : s.mentor;
        const duration = Math.round(
          (new Date(s.ends_at).getTime() -
            new Date(s.starts_at).getTime()) /
            60000,
        );
        return (
          <Card key={s.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-ink">
                  {mentor?.full_name ?? mentor?.email}
                </h3>
                <p className="text-xs text-ink-soft">
                  <LocalTime value={s.starts_at} /> · {duration} min
                </p>
                {s.notes && (
                  <p className="mt-2 text-sm text-ink-soft">{s.notes}</p>
                )}
                {s.mine && s.zoom_url && (
                  <a
                    href={s.zoom_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-spark-ink hover:underline"
                  >
                    <Video className="h-3 w-3" /> Join Zoom
                  </a>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                {s.mine ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" /> Booked
                    </span>
                    <button
                      onClick={() => release(s.booking_id)}
                      disabled={pending}
                      className="text-xs text-ink-faint hover:text-amber-700 dark:text-amber-300"
                    >
                      Cancel booking
                    </button>
                  </>
                ) : s.taken ? (
                  <span className="rounded-full bg-wash px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                    Taken
                  </span>
                ) : active === s.id ? (
                  <div className="w-72 max-w-full">
                    <Textarea
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      placeholder="What do you want to talk about?"
                      rows={2}
                      maxLength={280}
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setActive(null)}
                        disabled={pending}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => book(s.id)}
                        disabled={pending}
                      >
                        {pending ? "Booking…" : "Confirm"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      setActive(s.id);
                      setTopic("");
                    }}
                  >
                    Book
                  </Button>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
