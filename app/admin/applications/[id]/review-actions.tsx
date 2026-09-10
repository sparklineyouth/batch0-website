"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  decideApplication,
  reopenApplication,
  waiveApplicationFee,
  scheduleAcceptance,
  cancelScheduledAcceptance,
} from "./actions";
import { getActionError } from "@/lib/action-error";

// Starter notes the reviewer can drop in and personalize. Each one is
// short on purpose — leaves space for one or two lines of specifics
// before the student reads it.
const NOTE_TEMPLATES: { label: string; body: string }[] = [
  {
    label: "Accept · strong",
    body:
      "Excited to have you in the cohort. Your application stood out — looking forward to seeing what you build. We'll send onboarding details once payment is in.",
  },
  {
    label: "Accept · stretch",
    body:
      "We're admitting you. The bar in this cohort is high, so come ready to ship. One thing to focus on early: ",
  },
  {
    label: "Reject · close",
    body:
      "Thanks for applying. This was a close call and we'd love to see you apply again next cohort. To strengthen the next application, focus on: ",
  },
  {
    label: "Reject · standard",
    body:
      "Thanks for applying. We can't offer you a seat in this cohort — we had more strong applicants than seats. If you keep building, we'd love to see another application from you.",
  },
  {
    label: "Need more info",
    body:
      "Before we make a decision we need a little more from you: ",
  },
];

export function ReviewActions({
  applicationId,
  status,
  feeWaived,
  initialNotes,
  priceLabel = "$130",
  passHolder = false,
  initialFeedback,
  scheduledAcceptAt = null,
  scheduledAcceptNotes = null,
}: {
  applicationId: string;
  status: string;
  feeWaived: boolean;
  initialNotes: string;
  priceLabel?: string;
  /** Whether the applicant holds a founder pass — gates the structured
   *  feedback fields and the "can't form-letter a decline" requirement. */
  passHolder?: boolean;
  initialFeedback?: {
    strongest: string;
    missing: string;
    nextStep: string;
    secondReview: boolean | null;
  };
  /** A parked acceptance (migration 0062): UTC ISO timestamp of when the
   *  system will auto-accept, and the notes it will send. Null when nothing
   *  is scheduled. */
  scheduledAcceptAt?: string | null;
  scheduledAcceptNotes?: string | null;
}) {
  const router = useRouter();
  // While an acceptance is parked, review_notes is still empty (we haven't
  // decided yet) — the notes live in scheduled_accept_notes. Seed the textarea
  // from those so "with the notes below" reads true and a reschedule keeps them.
  const [notes, setNotes] = useState(initialNotes || scheduledAcceptNotes || "");
  const [strongest, setStrongest] = useState(initialFeedback?.strongest ?? "");
  const [missing, setMissing] = useState(initialFeedback?.missing ?? "");
  const [nextStep, setNextStep] = useState(initialFeedback?.nextStep ?? "");
  const [secondReview, setSecondReview] = useState(
    initialFeedback?.secondReview ?? false,
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmWaive, setConfirmWaive] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  // Whether the "schedule for later" row is expanded, and the datetime-local
  // value the reviewer picked. datetime-local is a naive "2026-09-10T06:00"
  // string in the browser's OWN timezone — we resolve it to an absolute UTC
  // instant before sending, so 6am means 6am where the reviewer sits.
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  function applyTemplate(body: string) {
    // If the textarea is empty, drop the template in. Otherwise append on
    // a new paragraph so the reviewer doesn't lose what they already
    // wrote — they can still personalize the appended text.
    setNotes((prev) => (prev.trim() ? `${prev.trim()}\n\n${body}` : body));
  }

  function decide(decision: "accepted" | "rejected" | "waitlisted") {
    setError(undefined);
    start(async () => {
      try {
        await decideApplication(
          applicationId,
          decision,
          notes,
          passHolder
            ? { strongest, missing, nextStep, secondReview }
            : undefined,
        );
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function schedule() {
    setError(undefined);
    if (!scheduleAt) {
      setError("Pick a date and time to auto-accept.");
      return;
    }
    const picked = new Date(scheduleAt);
    if (Number.isNaN(picked.getTime())) {
      setError("That date and time didn't parse — pick again.");
      return;
    }
    if (picked.getTime() <= Date.now()) {
      setError("Pick a time in the future — to accept now, use Accept.");
      return;
    }
    // Send an absolute UTC instant, resolved from the reviewer's local wall
    // clock, so the server (which runs in UTC) fires at the intended moment.
    const iso = picked.toISOString();
    start(async () => {
      try {
        await scheduleAcceptance(applicationId, iso, notes);
        setShowSchedule(false);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function cancelSchedule() {
    setError(undefined);
    start(async () => {
      try {
        await cancelScheduledAcceptance(applicationId);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function reopen() {
    setError(undefined);
    start(async () => {
      try {
        await reopenApplication(applicationId);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function waive() {
    setError(undefined);
    start(async () => {
      try {
        await waiveApplicationFee(applicationId, waiveReason);
        setConfirmWaive(false);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  const decided =
    status === "accepted" ||
    status === "rejected" ||
    status === "paid" ||
    status === "enrolled";
  const canWaive =
    !feeWaived &&
    (status === "accepted" || status === "submitted" || status === "draft");

  // A parked acceptance only makes sense while the app is still undecided.
  const hasSchedule = !!scheduledAcceptAt && !decided;
  const scheduledLabel = scheduledAcceptAt
    ? new Date(scheduledAcceptAt).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  // Floor "now" to the minute for the input's min= so the picker can't offer a
  // moment already in the past by the time it renders.
  const minLocal = (() => {
    const d = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="notes">Notes (optional, visible to applicant)</Label>
        <Textarea
          id="notes"
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={pending}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">
            Templates
          </span>
          {NOTE_TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => applyTemplate(t.body)}
              disabled={pending}
              className="rounded-full border border-line bg-wash px-2.5 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {passHolder && !decided && (
        <div className="space-y-3 rounded-lg border border-phosphor/30 bg-phosphor/[0.04] p-4">
          <div>
            <p className="text-sm font-semibold text-phosphor-ink">
              Founder pass — structured feedback
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              A pass application can&apos;t be declined with a form letter. Fill
              these in to Reject; they&apos;re shown to the applicant and emailed.
            </p>
          </div>
          <div>
            <Label htmlFor="fb-strongest">What was strongest</Label>
            <Textarea
              id="fb-strongest"
              rows={2}
              value={strongest}
              disabled={pending}
              onChange={(e) => setStrongest(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="fb-missing">What was missing</Label>
            <Textarea
              id="fb-missing"
              rows={2}
              value={missing}
              disabled={pending}
              onChange={(e) => setMissing(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="fb-next">Most useful next step</Label>
            <Textarea
              id="fb-next"
              rows={2}
              value={nextStep}
              disabled={pending}
              onChange={(e) => setNextStep(e.target.value)}
            />
          </div>
          <Toggle
            label="Eligible for a second review"
            description="Shown to the applicant. The seven-day rebuild is offered on any decline regardless."
            checked={secondReview}
            disabled={pending}
            onChange={setSecondReview}
          />
        </div>
      )}

      {/* A parked acceptance: shown while the app is still undecided so the
          reviewer can see it's queued and back out. The cron fires it. */}
      {hasSchedule && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2.5">
          <p className="text-sm text-ink-soft">
            <span aria-hidden>⏰</span> Auto-accepts{" "}
            <strong className="text-ink">{scheduledLabel}</strong>
            {scheduledAcceptNotes ? " — with the notes below." : "."}
          </p>
          <Button
            variant="secondary"
            onClick={cancelSchedule}
            disabled={pending}
          >
            Cancel schedule
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!decided && (
          <>
            <Button onClick={() => decide("accepted")} disabled={pending}>
              {pending ? "…" : "Accept"}
            </Button>
            {/* Waitlist is a middle decision, not a final one — the app
                stays decidable, so Accept/Reject remain available after. */}
            {status !== "waitlisted" && (
              <Button
                variant="secondary"
                onClick={() => decide("waitlisted")}
                disabled={pending}
              >
                Waitlist
              </Button>
            )}
            <Button
              variant="danger"
              onClick={() => decide("rejected")}
              disabled={pending}
            >
              Reject
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowSchedule((s) => !s)}
              disabled={pending}
            >
              {hasSchedule ? "Reschedule accept" : "Schedule accept…"}
            </Button>
          </>
        )}
        {(status === "accepted" ||
          status === "rejected" ||
          status === "waitlisted") && (
          <Button variant="secondary" onClick={reopen} disabled={pending}>
            Re-open for review
          </Button>
        )}
        {canWaive && (
          <Button
            variant="secondary"
            onClick={() => setConfirmWaive(true)}
            disabled={pending}
          >
            Waive fee &amp; enroll
          </Button>
        )}
        {feeWaived && (
          <span className="inline-flex items-center rounded-full border border-phosphor/30 bg-phosphor/10 px-2.5 py-1 text-xs font-medium text-phosphor-ink">
            Fee waived
          </span>
        )}
        {(status === "paid" || status === "enrolled") && !feeWaived && (
          <p className="text-sm text-ink-soft">
            Payment received. Application is locked.
          </p>
        )}
      </div>

      {!decided && showSchedule && (
        <div className="space-y-3 rounded-lg border border-line bg-wash p-4">
          <div>
            <p className="text-sm font-semibold text-ink">
              Accept automatically, later
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              The system accepts this application at the time you pick, sending
              the notes above. Until then it stays undecided, and a manual
              decision cancels the schedule.
            </p>
          </div>
          <div>
            <Label htmlFor="schedule-at">Accept at (your local time)</Label>
            <Input
              id="schedule-at"
              type="datetime-local"
              min={minLocal}
              value={scheduleAt}
              disabled={pending}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={schedule} disabled={pending}>
              {pending ? "…" : "Schedule accept"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowSchedule(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmWaive}
        title="Waive enrollment fee?"
        description={
          <>
            <p>
              This skips the {priceLabel} charge entirely and enrolls the
              student in the cohort right now. They'll get an email confirming
              access.
            </p>
            <div className="mt-3 text-left">
              <Label>Reason (optional, for your records)</Label>
              <Textarea
                rows={2}
                value={waiveReason}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="e.g. need-based scholarship"
              />
            </div>
          </>
        }
        confirmLabel="Waive &amp; enroll"
        pending={pending}
        onConfirm={waive}
        onCancel={() => !pending && setConfirmWaive(false)}
      />
    </div>
  );
}
