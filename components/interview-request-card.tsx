"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import {
  requestInterview,
  cancelInterviewRequest,
} from "@/app/calls/interview-actions";
import type { InterviewRequest } from "@/lib/interview-requests";
import type {
  InterviewCardState,
  InterviewStage,
  TeamRequestKind,
} from "@/lib/call-lifecycle";
import {
  CalendarClock,
  CheckCircle,
  Clock,
  MessageCircle,
  Sparkles,
  X,
} from "lucide-react";

/** Every string that differs between the two kinds of request, in one place. */
const COPY: Record<
  TeamRequestKind,
  {
    eyebrow: string;
    title: string;
    blurb: string;
    button: string;
    placeholder: string;
    requested: string;
    booked: string;
    bookedLead: string;
    done: string;
    doneBody: string;
  }
> = {
  interview: {
    eyebrow: "Before kickoff",
    title: "Request a getting-to-know-you interview",
    blurb:
      "A short, no-pressure video call with the batch0 team before your cohort starts. Tell us when you’re free and we’ll confirm a time.",
    button: "Request an interview",
    placeholder: "What you're building, what you'd love to talk about…",
    requested: "Interview requested",
    booked: "Interview booked",
    bookedLead: "Your getting-to-know-you interview is on the calendar",
    done: "Interview done",
    doneBody:
      "Thanks for making time to meet the team. It’s under Past in your 1:1 calls, with the recording if there is one.",
  },
  call: {
    eyebrow: "1:1 with the team",
    title: "Request a 1:1 call",
    blurb:
      "Stuck, want feedback, or need to talk something through? Ask for a private video call with the batch0 team whenever you need one. Tell us when you’re free and we’ll confirm a time.",
    button: "Request a call",
    placeholder: "What you'd like to talk about, and anything we should look at first…",
    requested: "Call requested",
    booked: "Call booked",
    bookedLead: "Your 1:1 with the batch0 team is on the calendar",
    done: "Call done",
    doneBody:
      "It’s under Past in your 1:1 calls, with the recording if there is one.",
  },
};

/**
 * A student's request for a 1:1 with the team (interview_requests, migration
 * 0061). Any enrolled student can ask whenever they want and the team
 * confirms a time: before kickoff it reads as the getting-to-know-you
 * interview, from kickoff on as an ordinary 1:1 call (TeamRequestKind).
 *
 * One component, four states, so a student sees the same thing whether they
 * land on it from the calls page, the dashboard home, or the enrolled page:
 *
 *  - compose    → a prompt with an inline form to ask
 *  - requested  → "waiting on the team", with a way to withdraw
 *  - booked     → the call exists and hasn't happened yet
 *  - done       → the call's time has come and gone
 *
 * WHICH state is decided by the page, from the request and the call it booked
 * (interviewStage / interviewCardState in lib/call-lifecycle.ts). The request's
 * own status stops at `scheduled` for ever, so a card that read it alone said
 * "Interview booked" over a call that had been cancelled, and over one that
 * had already happened — two of the three in production.
 *
 * `variant` only tunes the chrome: "full" leads with a heading (the calls
 * page and enrolled page give it room), "compact" is the tighter card the
 * dashboard home drops into a column.
 */
export function InterviewRequestCard({
  request,
  state: stateProp,
  variant = "full",
  composeKind = "call",
  lastStage = null,
}: {
  request: InterviewRequest | null;
  /**
   * What to show. Omitted, it falls back to the request's own status — which
   * is only right for a request whose call nobody has touched since, so every
   * page passes the derived state.
   */
  state?: InterviewCardState;
  variant?: "full" | "compact";
  /**
   * What a NEW request would be, decided by the page: an interview before the
   * student's cohort starts, a call after. A request already filed carries
   * its own kind.
   */
  composeKind?: TeamRequestKind;
  /**
   * Where the student's last request ended up (interviewStage), so the ask
   * can say why it is showing again: their last call happened, or it did
   * not go ahead.
   */
  lastStage?: InterviewStage | null;
}) {
  const state: InterviewCardState =
    stateProp ??
    (request?.status === "scheduled"
      ? "booked"
      : request?.status === "requested"
        ? "requested"
        : "compose");
  // A request in flight speaks in its own kind. A fresh ask uses the page's,
  // except after a call that already happened: a second "getting to know
  // you" would be odd, so from then on it is simply a call.
  const kind: TeamRequestKind =
    state === "compose"
      ? lastStage === "done"
        ? "call"
        : composeKind
      : (request?.kind ?? composeKind);
  const copy = COPY[kind];
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const [preferred, setPreferred] = useState(defaultStart());
  const [alt, setAlt] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        await requestInterview({
          preferredAt: new Date(preferred).toISOString(),
          altAt: alt ? new Date(alt).toISOString() : null,
          note: note.trim() || null,
        });
        setComposing(false);
        setAlt("");
        setNote("");
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  function withdraw() {
    if (!request) return;
    setError(undefined);
    start(async () => {
      try {
        await cancelInterviewRequest(request.id);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  const shell =
    "rounded-xl border border-line bg-wash p-5" +
    (variant === "compact" ? "" : " md:p-6");

  if (state === "hidden") return null;

  // ---- Done ----------------------------------------------------------------
  if (state === "done") {
    return (
      <div className={shell}>
        <Eyebrow icon={CheckCircle}>{copy.done}</Eyebrow>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {copy.doneBody}
        </p>
      </div>
    );
  }

  // ---- Booked ----------------------------------------------------------------
  if (state === "booked") {
    const needsAnswer = request?.call?.status === "invited";
    return (
      <div className={shell}>
        <Eyebrow icon={CheckCircle}>{copy.booked}</Eyebrow>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {copy.bookedLead}
          {request?.call && (
            <>
              {" "}for{" "}
              <span className="font-medium text-ink">
                <LocalTime value={request.call.startsAt} mode="datetime-short" />
              </span>
            </>
          )}
          .{" "}
          {needsAnswer
            ? "Head to your 1:1 calls to accept the time, then join when it starts."
            : "Join from your 1:1 calls when it starts."}
        </p>
        <Link
          href="/dashboard/calls"
          className="press mt-4 inline-flex items-center gap-2 rounded-md bg-phosphor px-4 py-2 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200"
        >
          <CalendarClock className="h-4 w-4" /> Open 1:1 calls
        </Link>
      </div>
    );
  }

  // ---- Requested (waiting) -------------------------------------------------
  if (state === "requested" && request) {
    return (
      <div className={shell}>
        <Eyebrow icon={Clock}>{copy.requested}</Eyebrow>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          The batch0 team has your request and will confirm a time soon. If
          they confirm one of yours, it&rsquo;s booked, with nothing more for
          you to do. You asked for{" "}
          <span className="font-medium text-ink">
            <LocalTime value={request.preferredAt} mode="datetime-short" />
          </span>
          {request.altAt && (
            <>
              {" "}
              or{" "}
              <span className="font-medium text-ink">
                <LocalTime value={request.altAt} mode="datetime-short" />
              </span>
            </>
          )}
          .
        </p>
        {request.note && (
          <p className="mt-2 text-sm text-ink-faint">&ldquo;{request.note}&rdquo;</p>
        )}
        <button
          type="button"
          onClick={withdraw}
          disabled={pending}
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-ink-faint underline underline-offset-2 hover:text-ink disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" /> Withdraw request
        </button>
        {error && <FieldError>{error}</FieldError>}
      </div>
    );
  }

  // ---- No request: prompt + inline form ------------------------------------
  return (
    <div className={shell}>
      <Eyebrow icon={kind === "interview" ? Sparkles : MessageCircle}>
        {copy.eyebrow}
      </Eyebrow>
      <p
        className={
          "mt-2 font-medium text-ink " +
          (variant === "compact" ? "text-[15px]" : "text-base")
        }
      >
        {copy.title}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">{copy.blurb}</p>
      {/* The ask shows again after a request's call happened or fell
          through; say which, so it doesn't look like the last one was lost. */}
      {lastStage === "done" && request?.call && (
        <p className="mt-2 text-sm text-ink-faint">
          Your last call was{" "}
          <LocalTime value={request.call.startsAt} mode="datetime-short" />.
          Ask for another whenever you need one.
        </p>
      )}
      {lastStage === "fell_through" && (
        <p className="mt-2 text-sm text-ink-faint">
          Your last call didn&rsquo;t go ahead. Ask for a new time whenever
          suits you.
        </p>
      )}

      {!composing ? (
        <Button className="mt-4" onClick={() => setComposing(true)}>
          {copy.button}
        </Button>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Preferred time</Label>
              <Input
                type="datetime-local"
                value={preferred}
                onChange={(e) => setPreferred(e.target.value)}
              />
            </div>
            <div>
              <Label>Alternate time (optional)</Label>
              <Input
                type="datetime-local"
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Anything you&rsquo;d like us to know (optional)</Label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={copy.placeholder}
            />
          </div>
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-2">
            <Button disabled={pending || !preferred} onClick={submit}>
              {pending ? "Sending…" : "Send request"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setComposing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Eyebrow({
  icon: Icon,
  children,
}: {
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
      <Icon className="h-3.5 w-3.5" /> {children}
    </p>
  );
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
