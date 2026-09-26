"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea, Label } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { requestScholarshipCall } from "@/app/calls/scholarship-call-actions";

export type ScholarshipCallState = {
  scholarshipName: string;
  granted: number;
  remaining: number;
  /** True when a request is already waiting on the team. */
  hasOpenRequest: boolean;
  /**
   * Set once the award's cohort is over — the calls were for that cohort, so
   * the card explains instead of offering a booking. Null while it runs.
   */
  closedReason?: string | null;
  /** The last instant a call can be proposed for (ISO): the end of the cohort's last day. */
  bookableUntil?: string | null;
  /** The same, as people read it: "Nov 13". */
  bookableUntilLabel?: string | null;
  cohortName?: string | null;
};

/** An ISO instant as a datetime-local value in the browser's own zone, for `max`. */
function toLocalInput(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Book a mentor call funded by a learner's scholarship.
 *
 * Shown only to a student who actually holds calls-type award with credits
 * left. The balance is stated plainly on every state, including zero, because
 * "how many do I have left" is the only question this card exists to answer —
 * an award whose balance is invisible gets forgotten, which is the failure
 * mode the scholarship is meant to avoid.
 */
export function ScholarshipCallCard({ state }: { state: ScholarshipCallState }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preferredAt, setPreferredAt] = useState("");
  const [altAt, setAltAt] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();

  const used = state.granted - state.remaining;
  // Rendered only after the student opens the form, which is client-side, so
  // the browser's own zone is the right one for the picker's ceiling.
  const maxLocal = toLocalInput(state.bookableUntil);

  function submit() {
    setError(undefined);
    if (!preferredAt) {
      setError("Pick a time that works for you.");
      return;
    }
    start(async () => {
      try {
        const res = await requestScholarshipCall({
          // datetime-local has no timezone; the browser's own offset is the
          // right reading of what the student typed.
          preferredAt: new Date(preferredAt).toISOString(),
          altAt: altAt ? new Date(altAt).toISOString() : null,
          note: note.trim() || null,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setOpen(false);
        setPreferredAt("");
        setAltAt("");
        setNote("");
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <Card className="border-phosphor/40 bg-phosphor/5">
      <h2 className="text-lg font-semibold text-phosphor-ink">
        {state.scholarshipName}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        <strong className="text-ink">
          {state.remaining} of {state.granted}
        </strong>{" "}
        extra mentor {state.granted === 1 ? "call" : "calls"} left
        {used > 0 ? ` · ${used} used` : ""}. These are on top of everything else
        in the program.
      </p>

      {state.closedReason ? (
        <p className="mt-3 text-sm text-ink-soft">
          {state.closedReason} Regular office hours and the team are still
          there — nothing about this closes a door.
        </p>
      ) : state.hasOpenRequest ? (
        <p className="mt-3 text-sm text-ink-soft">
          You've got a request waiting on the team. Once they book it, you can
          ask for the next one.
        </p>
      ) : state.remaining <= 0 ? (
        <p className="mt-3 text-sm text-ink-soft">
          You've used all of them. Regular office hours and the team are still
          there — nothing about this closes a door.
        </p>
      ) : !open ? (
        <div className="mt-4">
          <Button onClick={() => setOpen(true)}>Book a call</Button>
          <p className="mt-2 text-xs text-ink-faint">
            Tell us roughly when, and what you want to dig into. The more
            specific the topic, the more useful the call.
            {state.bookableUntilLabel && (
              <>
                {" "}
                Book one for any time up to {state.bookableUntilLabel}
                {state.cohortName ? `, while ${state.cohortName} runs` : ""}.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sc-preferred" required>
                When works? *
              </Label>
              <Input
                id="sc-preferred"
                type="datetime-local"
                max={maxLocal}
                value={preferredAt}
                onChange={(e) => setPreferredAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="sc-alt">A backup time</Label>
              <Input
                id="sc-alt"
                type="datetime-local"
                max={maxLocal}
                value={altAt}
                onChange={(e) => setAltAt(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="sc-note">What do you want to work on?</Label>
            <Textarea
              id="sc-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. we can't decide between two pricing models, and I want to talk it through with someone who's done it."
            />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex items-center gap-2">
            <Button disabled={pending} onClick={submit}>
              {pending ? "Sending…" : "Request the call"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
          <p className="text-xs text-ink-faint">
            Times are suggestions — the team confirms the real one. Your credit
            isn't used until they actually book it.
          </p>
        </div>
      )}
    </Card>
  );
}
