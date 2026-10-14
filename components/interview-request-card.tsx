"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import { defaultStart, toLocalInput } from "@/components/live/invite-form";
import { requestInterview, cancelInterviewRequest } from "@/app/calls/interview-actions";
import { requestScholarshipCall } from "@/app/calls/scholarship-call-actions";
import type { InterviewRequest } from "@/lib/interview-requests";
import type { RequestCardState } from "@/lib/call-lifecycle";
import { Clock, MessageCircle, X } from "lucide-react";

/** A learner's-scholarship mentor-call balance (migration 0071), when the student holds one. */
export type ScholarshipCallState = {
  scholarshipName: string;
  granted: number;
  remaining: number;
  /** Set once the award's cohort is over: no more bookings. */
  closedReason: string | null;
  /** The last instant a scholarship call can be proposed for (ISO). */
  bookableUntil: string | null;
};

/**
 * "Request a 1:1" — the student's one way to ask the team for a call, on
 * /dashboard/calls. A student holding scholarship mentor calls ticks a box to
 * use one; the credit is spent when the team books it.
 */
export function InterviewRequestCard({
  request,
  state,
  scholarship = null,
  requestIsScholarship = false,
}: {
  request: InterviewRequest | null;
  state: RequestCardState;
  scholarship?: ScholarshipCallState | null;
  /** The waiting request is a scholarship call. */
  requestIsScholarship?: boolean;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [preferred, setPreferred] = useState(defaultStart);
  const [alt, setAlt] = useState("");
  const [note, setNote] = useState("");
  const [useCredit, setUseCredit] = useState(false);

  const canUseCredit = !!scholarship && !scholarship.closedReason && scholarship.remaining > 0;
  const creditMax =
    useCredit && scholarship?.bookableUntil ? toLocalInput(scholarship.bookableUntil) : undefined;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(undefined);
    start(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        after?.();
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  function submit() {
    const input = {
      preferredAt: new Date(preferred).toISOString(),
      altAt: alt ? new Date(alt).toISOString() : null,
      note: note.trim() || null,
    };
    run(
      () => (useCredit && canUseCredit ? requestScholarshipCall(input) : requestInterview(input)),
      () => {
        setComposing(false);
        setAlt("");
        setNote("");
      },
    );
  }

  if (state === "hidden") return null;

  const shell = "rounded-xl border border-line bg-wash p-5";

  if (state === "requested" && request) {
    return (
      <div className={shell}>
        <Eyebrow icon={Clock}>{requestIsScholarship ? "Scholarship call requested" : "1:1 requested"}</Eyebrow>
        <p className="mt-2 text-sm text-ink-soft">
          You asked for{" "}
          <span className="font-medium text-ink">
            <LocalTime value={request.preferredAt} mode="datetime-short" />
          </span>
          {request.altAt && (
            <>
              {" "}or{" "}
              <span className="font-medium text-ink">
                <LocalTime value={request.altAt} mode="datetime-short" />
              </span>
            </>
          )}
          . The team will book a time.
        </p>
        <button
          type="button"
          onClick={() => run(() => cancelInterviewRequest(request.id))}
          disabled={pending}
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-ink-faint underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" /> Withdraw
        </button>
        {error && <FieldError>{error}</FieldError>}
      </div>
    );
  }

  return (
    <div className={shell}>
      <Eyebrow icon={MessageCircle}>Request a 1:1</Eyebrow>
      <p className="mt-2 text-sm text-ink-soft">
        A private video call with the batch0 team. Suggest a time; we&rsquo;ll book it.
      </p>
      {scholarship && (
        <p className="mt-1 text-xs text-ink-faint">
          {scholarship.scholarshipName}: {scholarship.remaining} of {scholarship.granted} mentor calls left
          {scholarship.closedReason ? `. ${scholarship.closedReason}` : "."}
        </p>
      )}

      {!composing ? (
        <Button className="mt-4" onClick={() => setComposing(true)}>
          Request a 1:1
        </Button>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Preferred time</Label>
              <Input
                type="datetime-local"
                value={preferred}
                max={creditMax}
                onChange={(e) => setPreferred(e.target.value)}
              />
            </div>
            <div>
              <Label>Backup time (optional)</Label>
              <Input
                type="datetime-local"
                value={alt}
                max={creditMax}
                onChange={(e) => setAlt(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>What about (optional)</Label>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {canUseCredit && (
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={useCredit}
                onChange={(e) => setUseCredit(e.target.checked)}
              />
              Use a scholarship mentor call
            </label>
          )}
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-2">
            <Button disabled={pending || !preferred} onClick={submit}>
              {pending ? "Sending…" : "Send request"}
            </Button>
            <Button variant="ghost" onClick={() => setComposing(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Eyebrow({ icon: Icon, children }: { icon: any; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
      <Icon className="h-3.5 w-3.5" /> {children}
    </p>
  );
}
