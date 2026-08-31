"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronDown, Sparkles } from "lucide-react";
import { decideApplication } from "@/app/admin/applications/[id]/actions";
import { getActionError } from "@/lib/action-error";

export type ReviewItem = {
  id: string;
  fullName: string;
  email: string | null;
  status: string;
  age: number | null;
  grade: string | null;
  school: string | null;
  location: string | null;
  hoursPerWeek: number | null;
  whyJoin: string | null;
  startupIdea: string | null;
  experience: string | null;
  aiScore: number | null;
  aiSummary: string | null;
  submittedAt: string | null;
  /** Holds a founder pass — a decline owes them written feedback. */
  holdsPass: boolean;
};

type Decision = "accepted" | "waitlisted" | "rejected";

/**
 * One application, decidable in place.
 *
 * It calls `decideApplication` — the same server action the desktop reviewer
 * uses — so a decision made from a phone sends the acceptance email, fires the
 * automation event, writes the audit row, syncs Discord roles and creates the
 * in-app notification, exactly as it would from a laptop. There is no
 * "mobile decision" that behaves differently, because a half-decision is worse
 * than no decision: it looks done in the queue while the applicant hears
 * nothing.
 *
 * Two guards make declining safe on a small screen:
 *
 *   Decline requires a confirmation tap. Accept and waitlist are recoverable
 *   (`reopenApplication` exists, and a waitlist can still become a yes). A
 *   rejection sends an email the moment it lands. A mis-tap next to the thumb
 *   should not be able to do that.
 *
 *   For a founder-pass holder the notes box is required before Decline is
 *   enabled. The server enforces this too and will throw — this is here so the
 *   reviewer learns it before writing off a decision, not after.
 */
export function ReviewCard({ item }: { item: ReviewItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Decision | null>(null);
  const [pending, startTransition] = useTransition();

  const needsNotes = item.holdsPass && !notes.trim();

  function decide(decision: Decision) {
    // Rejection is the one-way door. Everything else applies immediately.
    if (decision === "rejected" && confirming !== "rejected") {
      setConfirming("rejected");
      return;
    }
    setError(null);
    setConfirming(null);
    startTransition(async () => {
      try {
        await decideApplication(item.id, decision, notes);
        setDone(decision);
        // The action revalidates /admin/applications; refresh pulls this row
        // out of the queue we're standing in.
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
        <p className="text-[14px] text-emerald-700 dark:text-emerald-300">
          {item.fullName} — {DECISION_LABEL[done]}.
        </p>
        <p className="mt-1 text-[12px] text-ink-soft">
          Email sent and the decision is in the audit log.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-wash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-paper"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight text-ink">
            {item.fullName}
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
            {[
              item.grade && `Grade ${item.grade}`,
              item.location,
              item.hoursPerWeek && `${item.hoursPerWeek}h/wk`,
            ]
              .filter(Boolean)
              .join(" · ") || item.email}
          </p>
        </div>
        {item.holdsPass && (
          <span className="shrink-0 rounded-full bg-phosphor/15 px-2 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-phosphor-ink">
            Pass
          </span>
        )}
        {item.aiScore !== null && (
          <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-ink-soft">
            {item.aiScore}
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink-faint transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="border-t border-line bg-paper px-4 py-4">
          {item.aiSummary && (
            <p className="mb-4 flex gap-2 rounded-lg border border-line bg-wash px-3 py-2.5 text-[12px] leading-relaxed text-ink-soft">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phosphor-ink" />
              <span>{item.aiSummary}</span>
            </p>
          )}

          <Answer label="Why batch0" body={item.whyJoin} />
          <Answer label="The idea" body={item.startupIdea} />
          <Answer label="Experience" body={item.experience} />

          <label className="mt-4 block">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
              Notes to the applicant
              {item.holdsPass && (
                <span className="ml-1.5 text-phosphor-ink">required</span>
              )}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={
                item.holdsPass
                  ? "This applicant holds a founder pass — a decline owes them real feedback."
                  : "Sent with the decision email. Optional."
              }
              className="mt-2 block w-full resize-y rounded-lg border border-line bg-wash px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
            />
          </label>

          {error && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="mt-4 grid grid-cols-3 gap-2">
            <Action
              tone="accept"
              disabled={pending}
              onClick={() => decide("accepted")}
            >
              Accept
            </Action>
            <Action
              tone="waitlist"
              disabled={pending}
              onClick={() => decide("waitlisted")}
            >
              Waitlist
            </Action>
            <Action
              tone="decline"
              disabled={pending || needsNotes}
              onClick={() => decide("rejected")}
            >
              {confirming === "rejected" ? "Sure?" : "Decline"}
            </Action>
          </div>
          {confirming === "rejected" && (
            <p className="mt-2 text-center text-[11px] text-ink-faint">
              Tap Decline again to send. This emails the applicant.
            </p>
          )}
          {needsNotes && (
            <p className="mt-2 text-center text-[11px] text-ink-faint">
              Founder-pass holders are promised written feedback on a decline.
            </p>
          )}

          <Link
            href={`/admin/applications/${item.id}`}
            prefetch={false}
            className="press mt-4 flex items-center justify-center gap-1.5 text-[12px] text-ink-soft active:text-ink"
          >
            Full application, review comments and scoring
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </div>
  );
}

const DECISION_LABEL: Record<Decision, string> = {
  accepted: "accepted",
  waitlisted: "waitlisted",
  rejected: "declined",
};

function Answer({ label, body }: { label: string; body: string | null }) {
  if (!body?.trim()) return null;
  return (
    <div className="mt-3 first:mt-0">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
        {label}
      </p>
      {/* Capped rather than scrolled: the decision is made on the shape of the
          answer, and a 900-word essay inside a phone card buries the buttons. */}
      <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">
        {body}
      </p>
    </div>
  );
}

function Action({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: "accept" | "waitlist" | "decline";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tones = {
    accept: "bg-phosphor text-on-phosphor",
    waitlist: "border border-line bg-wash text-ink",
    decline: "border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`press inline-flex h-11 select-none items-center justify-center rounded-md text-[13px] font-semibold leading-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
