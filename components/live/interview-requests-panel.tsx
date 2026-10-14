"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  CohostPicker,
  defaultStart,
  toLocalInput,
  type InviteeOption,
} from "@/components/live/invite-form";
import { scheduleInterviewRequest, declineInterviewRequest } from "@/app/calls/interview-actions";
import type { InterviewRequest } from "@/lib/interview-requests";
import { bookingPrefill, proposalsAllPast } from "@/lib/call-lifecycle";
import { AlertTriangle, CalendarClock, Check } from "lucide-react";

const DURATIONS = [15, 20, 30, 45, 60];

/**
 * The team's queue of "Request a 1:1" asks, on /admin/calls. Book writes a
 * real call (joinable, no accept step); Decline lets the student ask again.
 * Whoever books hosts, and can bring others from the team.
 */
export function InterviewRequestsPanel({
  requests,
  staff = [],
  now,
  scholarshipIds = [],
}: {
  requests: InterviewRequest[];
  /** Who can be added as co-hosts — the team, without the viewer. */
  staff?: InviteeOption[];
  /** The server's render time (ISO), stable across hydration. */
  now: string;
  /** Requests funded by a learner's scholarship. */
  scholarshipIds?: string[];
}) {
  if (requests.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">
        No requests waiting.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {requests.map((r) => (
        <RequestRow
          key={r.id}
          request={r}
          staff={staff}
          now={now}
          scholarship={scholarshipIds.includes(r.id)}
        />
      ))}
    </ul>
  );
}

function RequestRow({
  request,
  staff,
  now,
  scholarship,
}: {
  request: InterviewRequest;
  staff: InviteeOption[];
  now: string;
  scholarship: boolean;
}) {
  const router = useRouter();
  const [scheduling, setScheduling] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const stale = proposalsAllPast(request.preferredAt, request.altAt, new Date(now));
  // The student's first time still ahead, so "yes, that works" is one click.
  const [startsLocal, setStartsLocal] = useState(() => {
    const prefill = bookingPrefill(request.preferredAt, request.altAt, new Date(now));
    return prefill ? toLocalInput(prefill) : defaultStart();
  });
  const [duration, setDuration] = useState(30);
  const [cohostIds, setCohostIds] = useState<string[]>([]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(undefined);
    start(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error);
          return;
        }
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
                Scholarship
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
              <CalendarClock className="h-4 w-4" /> Book
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => declineInterviewRequest(request.id))}
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
        <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Their times have passed. Pick a new one or decline.
        </p>
      )}

      {scheduling && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
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
              <Select value={String(duration)} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} minutes
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <CohostPicker staff={staff} value={cohostIds} onChange={setCohostIds} />
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-2">
            <Button
              disabled={pending || !startsLocal}
              onClick={() =>
                run(() =>
                  scheduleInterviewRequest({
                    id: request.id,
                    startsAt: new Date(startsLocal).toISOString(),
                    durationMinutes: duration,
                    cohostIds,
                  }),
                )
              }
            >
              <Check className="h-4 w-4" />
              {pending ? "Booking…" : "Book call"}
            </Button>
            <Button variant="ghost" onClick={() => setScheduling(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && !scheduling && <FieldError>{error}</FieldError>}
    </li>
  );
}
