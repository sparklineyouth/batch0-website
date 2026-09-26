"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  scheduleInterviewRequest,
  declineInterviewRequest,
} from "@/app/calls/interview-actions";
import type { InterviewRequest } from "@/lib/interview-requests";
import { bookingPrefill, proposalsAllPast } from "@/lib/call-lifecycle";
import { AlertTriangle, CalendarClock, Check } from "lucide-react";

const DURATIONS = [15, 20, 30, 45, 60];

/**
 * The team's queue of "getting to know you" interview requests, on
 * /admin/calls. Each row can be scheduled — which confirms a time and writes a
 * real call_invites row (the student then accepts and joins like any 1:1) — or
 * declined.
 */
export function InterviewRequestsPanel({
  requests,
  now,
  scholarshipIds = [],
}: {
  requests: InterviewRequest[];
  /** The server's render time (ISO), so "have their times passed" is stable across hydration. */
  now: string;
  /** Requests that are learner's-scholarship calls rather than onboarding interviews. */
  scholarshipIds?: string[];
}) {
  if (requests.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">
        No interview requests waiting. Students ask for one from their dashboard
        before kickoff.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {requests.map((r) => (
        <RequestRow
          key={r.id}
          request={r}
          now={now}
          scholarship={scholarshipIds.includes(r.id)}
        />
      ))}
    </ul>
  );
}

function RequestRow({
  request,
  now,
  scholarship,
}: {
  request: InterviewRequest;
  now: string;
  scholarship: boolean;
}) {
  const router = useRouter();
  const [scheduling, setScheduling] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  // Every time the student offered has gone by. Booking at one of them is
  // refused (it's in the past), so the row says so up front instead of
  // letting "Book it" fail — it needs a new time, or a decline.
  const stale = proposalsAllPast(request.preferredAt, request.altAt, new Date(now));

  // Prefill the confirm form with the student's first choice that is still
  // AHEAD, so the common case — "yes, that works" — is one click on the
  // duration and Save. Never a time that has passed: the old prefill used
  // `preferredAt` unconditionally, so on a stale request the form's most
  // common click was a guaranteed "That time is in the past."
  const [startsLocal, setStartsLocal] = useState(
    () =>
      toLocalInput(bookingPrefill(request.preferredAt, request.altAt, new Date(now))) ??
      defaultStart(),
  );
  const [duration, setDuration] = useState(30);

  function schedule() {
    setError(undefined);
    start(async () => {
      try {
        await scheduleInterviewRequest({
          id: request.id,
          startsAt: new Date(startsLocal).toISOString(),
          durationMinutes: duration,
        });
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  function decline() {
    setError(undefined);
    start(async () => {
      try {
        await declineInterviewRequest(request.id);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <li className="rounded-lg border border-line bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            {request.studentName}
            {scholarship && (
              <span className="rounded-full bg-phosphor/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-phosphor-ink">
                Scholarship call
              </span>
            )}
          </p>
          <p className="truncate text-xs text-ink-faint">
            {request.studentEmail}
            {request.cohortName ? ` · ${request.cohortName}` : ""}
          </p>
        </div>
        {!scheduling && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => setScheduling(true)}>
              <CalendarClock className="h-4 w-4" /> Schedule
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={decline}
              disabled={pending}
            >
              Decline
            </Button>
          </div>
        )}
      </div>

      <dl className="mt-3 grid gap-1 text-xs text-ink-soft">
        <div className="flex gap-2">
          <dt className="text-ink-faint">Prefers</dt>
          <dd className="font-medium text-ink">
            <LocalTime value={request.preferredAt} mode="datetime-short" />
            {request.altAt && (
              <>
                {" "}
                or <LocalTime value={request.altAt} mode="datetime-short" />
              </>
            )}
          </dd>
        </div>
        {request.note && (
          <div className="flex gap-2">
            <dt className="text-ink-faint">Note</dt>
            <dd className="text-ink-soft">{request.note}</dd>
          </div>
        )}
      </dl>

      {stale && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {request.altAt ? "Both times they offered have" : "The time they offered has"}{" "}
          passed. Pick a new time, or decline so they can ask again.
        </p>
      )}

      {scheduling && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Confirm the time</Label>
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
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-2">
            <Button disabled={pending || !startsLocal} onClick={schedule}>
              <Check className="h-4 w-4" />
              {pending ? "Booking…" : "Book it"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setScheduling(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && !scheduling && <FieldError>{error}</FieldError>}
    </li>
  );
}

/** An ISO timestamp → the `datetime-local` input value, in the viewer's TZ. */
function toLocalInput(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
