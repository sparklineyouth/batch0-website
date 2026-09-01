"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronDown, Sparkles } from "lucide-react";
import { decideApplication } from "@/app/admin/applications/[id]/actions";
import { getActionError } from "@/lib/action-error";
// viz.tsx has no "use client" but no hooks either, so importing it here just
// bundles it. Its aria id counter is module-level and would restart on the
// client — harmless only because the panel that renders the Ring is closed on
// first paint, so the server never emits one of these ids to mismatch against.
import { Ring } from "@/components/app/viz";

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
 * Three guards make declining safe on a small screen:
 *
 *   Decline requires a confirmation. Accept and waitlist are recoverable
 *   (`reopenApplication` exists, and a waitlist can still become a yes). A
 *   rejection sends an email the moment it lands. A mis-tap next to the thumb
 *   should not be able to do that.
 *
 *   The confirmation is a different button in a different place, and the
 *   Decline cell goes disabled while it is up. Confirming in the same rect the
 *   arming tap landed in is not a confirmation — a double-tap satisfies it, so
 *   the guard was one impatient gesture wide. Collapsing the card disarms too,
 *   or an armed card reopened an hour later would send on a single tap.
 *
 *   For a founder-pass holder the notes box is required before Decline is
 *   enabled. The server enforces this too and will throw — this is here so the
 *   reviewer learns it before writing off a decision, not after.
 *
 * With `canDecide` false the same card renders without the notes box and the
 * button grid. A read-only role used to get a bare link into the desktop panel
 * per row instead — twenty-five of them, so every tappable thing on the screen
 * left the app. The answers, summary and score are already on this row, so a
 * reader can now do the whole reading job here and the only escape left is the
 * one the page argues for.
 */
export function ReviewCard({
  item,
  canDecide,
}: {
  item: ReviewItem;
  /** False for roles with `applications.view` but not `applications.review`. */
  canDecide: boolean;
}) {
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
        onClick={() => {
          // Collapsing disarms. `confirming` used to survive this toggle, so a
          // card armed for a decline could be collapsed, reopened later and
          // fired on a single tap. Disarming is done here rather than inside
          // the `setOpen` updater because next.config.js sets
          // `reactStrictMode: true`, which double-invokes updaters — they have
          // to stay pure.
          if (open) {
            setConfirming(null);
            setError(null);
          }
          setOpen((v) => !v);
        }}
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
        {/* The AI score used to sit here as a bare integer with no scale. It
            moved into the expanded panel: at 320px this header's text column
            is already down to ~138px, and a ring plus its "/10" would take
            another ~70px of it and cut the applicant's name to a few glyphs.
            A number you can't put a scale on is not worth the name. */}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink-faint transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="border-t border-line bg-paper px-4 py-4">
          {/* A div, not the <p> this used to be: Ring renders a <figure>, and a
              figure inside a paragraph is invalid nesting — the parser closes
              the <p> early, the client tree disagrees with the server HTML and
              React throws a hydration mismatch. */}
          {(item.aiScore !== null || item.aiSummary) && (
            <div className="mb-4 rounded-lg border border-line bg-wash px-3 py-2.5">
              {item.aiScore !== null && (
                // Score above the summary, because the summary is the argument
                // for the score. Stacked rather than truly side by side: the
                // ring and its "8/10" cost ~70px of the ~224px inside this box,
                // and the summary needs the rest to wrap sanely.
                <div className="flex items-center gap-2.5">
                  {/* aria-hidden: this is a sighted-only caption. Ring's
                      size-28 variant puts its label in an sr-only figcaption
                      ("AI score: 8 of 10, 80 percent") and points the graphic
                      at it, so leaving this exposed makes a screen reader say
                      "AI score" twice before it reaches the number. */}
                  <span
                    aria-hidden
                    className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint"
                  >
                    AI score
                  </span>
                  <Ring
                    label="AI score"
                    value={item.aiScore}
                    max={10}
                    size={28}
                  />
                </div>
              )}
              {item.aiSummary && (
                <p
                  className={`flex gap-2 text-[12px] leading-relaxed text-ink-soft ${
                    item.aiScore !== null ? "mt-2.5 border-t border-line pt-2.5" : ""
                  }`}
                >
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phosphor-ink" />
                  {/* The card is `overflow-hidden`, so an unbreakable token —
                      a URL the model quoted back — is clipped at the card edge
                      with no ellipsis and no scrollbar. `[overflow-wrap:anywhere]`
                      alone, never alongside `break-words`: both set the same
                      property and which one wins depends on utility order. */}
                  <span className="[overflow-wrap:anywhere]">{item.aiSummary}</span>
                </p>
              )}
            </div>
          )}

          <Answer label="Why batch0" body={item.whyJoin} />
          <Answer label="The idea" body={item.startupIdea} />
          <Answer label="Experience" body={item.experience} />

          {/* Everything below is gated on the permission, not just disabled by
              it. A notes box a read-only role can type into, above buttons it
              can never press, is a worse answer than not offering it. */}
          {canDecide && (
            <>
              <label className="mt-4 block">
                <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
                  Notes to the applicant
                  {item.holdsPass && (
                    <span className="ml-1.5 text-phosphor-ink">required</span>
                  )}
                </span>
                {/* 16px, and it has to stay 16px. Below that, iOS Safari zooms
                    the whole viewport when the field takes focus and never
                    zooms back out — and this is the field that gates a decline
                    for a founder-pass holder, so it is the one field in the app
                    an admin is guaranteed to type into. */}
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder={
                    item.holdsPass
                      ? "This applicant holds a founder pass — a decline owes them real feedback."
                      : "Sent with the decision email. Optional."
                  }
                  className="mt-2 block w-full resize-y rounded-lg border border-line bg-wash px-3 py-2.5 text-[16px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
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
                {/* Armed, this cell goes dead rather than becoming the confirm.
                    Arm and confirm used to be the same 44px rect at the same
                    coordinates with no disabled window, so an impatient
                    double-tap sent a rejection email in one gesture. */}
                <Action
                  tone="decline"
                  disabled={pending || needsNotes || confirming === "rejected"}
                  onClick={() => decide("rejected")}
                >
                  Decline
                </Action>
              </div>
              {confirming === "rejected" && (
                <div className="mt-3 space-y-2">
                  <p className="text-[12px] leading-relaxed text-ink-soft">
                    This emails {item.fullName} the decline immediately. There is
                    no undo.
                  </p>
                  {/* The confirm is a different target in a different place, and
                      the sentence above it puts ~40px between it and the cell
                      the reviewer's thumb just left. */}
                  <Action
                    tone="decline"
                    full
                    disabled={pending || needsNotes}
                    onClick={() => decide("rejected")}
                  >
                    Send the decline
                  </Action>
                  <Action
                    tone="neutral"
                    full
                    disabled={pending}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Action>
                </div>
              )}
              {needsNotes && (
                <p className="mt-2 text-center text-[11px] text-ink-faint">
                  Founder-pass holders are promised written feedback on a decline.
                </p>
              )}
            </>
          )}

          <Link
            href={`/admin/applications/${item.id}`}
            prefetch={false}
            // min-h-11 for the same reason as Show all: `a.press` only picks up
            // globals.css's 36px coarse-pointer floor, and this is the one
            // control on the card a read-only role has.
            className="press mt-4 flex min-h-11 items-center justify-center gap-1.5 text-[12px] text-ink-soft active:text-ink"
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
  const [expanded, setExpanded] = useState(false);
  if (!body?.trim()) return null;
  // A length test rather than a `scrollHeight > clientHeight` probe: the probe
  // has to run after layout, so on every short answer the control renders once
  // and then disappears — a flicker on the common case to be exact about the
  // rare one. Six lines of 13.5px text in a 248px card is roughly 200-260
  // characters, so 320 only ever offers the toggle on something genuinely cut.
  const clipped = body.length > 320;
  return (
    <div className="mt-3 first:mt-0">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
        {label}
      </p>
      {/* Capped rather than scrolled by default: the decision is made on the
          shape of the answer, and a 900-word essay inside a phone card buries
          the buttons. But capped is not the same as unreachable — the only way
          to the rest of it used to be the desktop link at the bottom of the
          card, which is a strange thing to need in order to read a paragraph.
          `[overflow-wrap:anywhere]` and not `break-words`: they set the same
          property and the winner would depend on utility source order. Without
          it a 60-character URL is clipped by line-clamp's own `overflow:
          hidden` with no ellipsis to say so. */}
      <p
        className={`mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-[13.5px] leading-relaxed text-ink ${
          expanded ? "" : "line-clamp-6"
        }`}
      >
        {body}
      </p>
      {clipped && (
        // `min-h-11`, not globals.css's coarse-pointer floor: that rule is
        // 36px, sized for the desktop admin tables its comment names. This app
        // holds a 44px floor, and 10px uppercase mono is exactly the label that
        // needs the padding it doesn't earn from its own line box.
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="press mt-1 inline-flex min-h-11 items-center font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-phosphor-ink"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function Action({
  tone,
  disabled,
  full,
  onClick,
  children,
}: {
  tone: "accept" | "waitlist" | "decline" | "neutral";
  disabled?: boolean;
  /** Own a whole line rather than a grid cell — the decline confirmation pair. */
  full?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tones = {
    accept: "bg-phosphor text-on-phosphor",
    waitlist: "border border-line bg-wash text-ink",
    decline: "border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
    // Same paint as `waitlist`, kept as its own key because it means something
    // else: backing out, not a decision. Merging them would make a later
    // restyle of the waitlist button silently restyle Cancel too.
    neutral: "border border-line bg-wash text-ink",
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // `flex w-full` when full, not `inline-flex w-full`: an inline-level box
      // sits in a line box and picks up descender space under it, which shows
      // as an uneven gap between the two stacked confirmation buttons.
      className={`press h-11 select-none items-center justify-center rounded-md text-[13px] font-semibold leading-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${
        full ? "flex w-full" : "inline-flex"
      } ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
