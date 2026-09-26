"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlus, CheckCircle2, Lock, PartyPopper } from "lucide-react";
import { buttonClasses, Button } from "@/components/ui/button";
import { Countdown } from "@/components/challenges/time";
import { ShareLink } from "@/components/challenges/share-link";
import { stashRefFromLocation } from "@/lib/referral-code";
import {
  clearChallengeRef,
  consumeJoinIntent,
  markJoinIntent,
  readChallengeRef,
  stashChallengeRef,
} from "@/lib/challenge-ref";
import {
  canRegister,
  challengePhase,
  isChallengeOpen,
  type Challenge,
  type SubmissionStatus,
} from "@/lib/challenges-shared";
import { registerForChallenge } from "./actions";

type Props = {
  slug: string;
  kind: Challenge["kind"];
  kindLabel: string;
  /** How many winners are publicly listed below (0 = none shown). */
  winnersShown: number;
  challenge: Pick<
    Challenge,
    | "status"
    | "opensAt"
    | "closesAt"
    | "resultsAt"
    | "winnersPublished"
    | "allowEdits"
    | "referralsRequired"
  >;
  signedIn: boolean;
  viewerName: string | null;
  registered: boolean;
  /** `status` is what the entrant may see (outcomes stay "submitted" until
   *  winners are published); `locked` says the entry can't be edited any more
   *  without saying why. Both are decided on the server. */
  submission: { status: SubmissionStatus; submittedAt: string | null; locked: boolean } | null;
  referral: { link: string; count: number } | null;
  /** ?join=1 — they clicked Register while signed out and just came back. */
  autoJoin: boolean;
  refCode: string | null;
  calendarUrl: string | null;
  icsUrl: string;
};

/** The referral code: the URL's first, then the one stashed for THIS
 *  challenge (never another challenge's, and never the cohort funnel's). */
function currentRef(slug: string, fromUrl: string | null): string | null {
  return fromUrl || readChallengeRef(slug);
}

/**
 * The registration box — the one thing on the event page that changes with
 * the viewer. Luma's rule: whatever state you're in, there is exactly one
 * obvious next action, and it's a single click.
 */
export function RegisterCard(p: Props) {
  const router = useRouter();
  const [registered, setRegistered] = useState(p.registered);
  const [justJoined, setJustJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [now, setNow] = useState<number | null>(null);
  const autoRan = useRef(false);

  useEffect(() => {
    // The cohort funnel's stash (so a friend who goes on to apply is still
    // attributed) and this challenge's own.
    stashRefFromLocation();
    stashChallengeRef(p.slug);
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const c = p.challenge;
  // Before hydration, trust the server's view (status only); after, the clock.
  const regOpen = now == null ? c.status === "active" : canRegister(c, now);
  const subOpen = now == null ? c.status === "active" : isChallengeOpen(c, now);
  const opensLater =
    !!c.opensAt && now != null && new Date(c.opensAt).getTime() > now;

  const selfPath = `/challenges/${p.slug}`;
  const joinNext = `${selfPath}?join=1${p.refCode ? `&ref=${encodeURIComponent(p.refCode)}` : ""}`;

  function register() {
    setError(null);
    start(async () => {
      const res = await registerForChallenge({
        slug: p.slug,
        refCode: currentRef(p.slug, p.refCode),
      });
      if (!res.ok) {
        if (res.signIn) {
          markJoinIntent(p.slug);
          window.location.assign(`/signup?next=${encodeURIComponent(joinNext)}`);
          return;
        }
        setError(res.error ?? "Couldn't register you.");
        return;
      }
      setRegistered(true);
      setJustJoined(true);
      clearChallengeRef(p.slug);
      router.refresh();
    });
  }

  // Came back from signup with ?join=1: finish the click they already made —
  // but ONLY if this browser actually made it (markJoinIntent on the click).
  // ?join=1 by itself is just a URL anyone can post in a group chat.
  useEffect(() => {
    if (!p.autoJoin || autoRan.current) return;
    autoRan.current = true;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("join");
      window.history.replaceState(null, "", url.pathname + url.search);
    } catch {}
    const intended = consumeJoinIntent(p.slug);
    if (intended && p.signedIn && !p.registered && c.status === "active") register();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sub = p.submission;
  const submitted = !!sub && sub.status !== "draft";
  const needsRefs = c.referralsRequired > 0 && !submitted;
  const refsLeft = p.referral ? Math.max(0, c.referralsRequired - p.referral.count) : c.referralsRequired;
  const isGiveaway = p.kind === "giveaway";

  let body: React.ReactNode;

  if (submitted) {
    const s = sub!.status;
    const canEditNow = c.allowEdits && subOpen && !sub!.locked;
    const verdict =
      s === "funded"
        ? { title: "You won! 🏆", text: "Congrats — we'll be in touch about your prize." }
        : c.winnersPublished
          ? {
              title: "Thanks for taking part",
              text: p.winnersShown > 0
                ? "Winners are out — see them below. You weren't picked this time, but the next one's coming."
                : "Winners have been picked, and you weren't one of them this time. The next one's coming.",
            }
          : s === "shortlisted"
            ? { title: "You're shortlisted", text: "You made the final round. Results soon." }
            : canEditNow
              ? { title: isGiveaway ? "You're entered" : "You're submitted", text: "You can keep editing until the deadline." }
              : { title: isGiveaway ? "You're entered" : "You're submitted", text: "Winners will be announced here." };
    body = (
      <>
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
          <div>
            <p className="font-semibold text-ink">{verdict.title}</p>
            <p className="mt-0.5 text-sm text-ink-soft">{verdict.text}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`${selfPath}/submit`} className={buttonClasses(canEditNow ? "primary" : "secondary", "md")}>
            {canEditNow ? "Edit your entry" : "View your entry"}
          </Link>
        </div>
      </>
    );
  } else if (registered) {
    body = (
      <>
        <div className="flex items-start gap-3">
          {justJoined ? (
            <PartyPopper className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
          )}
          <div>
            <p className="font-semibold text-ink">
              {justJoined ? "You're in!" : "You're registered"}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">
              {!regOpen
                ? "Submissions have closed."
                : opensLater
                  ? "Submissions open soon — you can start a draft now."
                  : sub
                    ? "Your draft is saved. Finish it before the deadline."
                    : "Your submission form autosaves, so start whenever."}
            </p>
          </div>
        </div>
        {regOpen && (
          <Link
            href={`${selfPath}/submit`}
            className={`${buttonClasses("primary", "lg")} mt-4 w-full`}
          >
            {sub
              ? "Continue your entry →"
              : opensLater
                ? "Start a draft →"
                : isGiveaway
                  ? "Enter →"
                  : "Submit your project →"}
          </Link>
        )}
        {needsRefs && regOpen && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-soft">
            <Lock className="h-3.5 w-3.5" />
            {refsLeft > 0
              ? `Refer ${refsLeft} more friend${refsLeft === 1 ? "" : "s"} to unlock submitting.`
              : "Referrals done — you're clear to submit."}
          </p>
        )}
      </>
    );
  } else if (!regOpen) {
    body = (
      <>
        <p className="font-semibold text-ink">
          {c.status === "active" || c.status === "closed" ? "Submissions are closed" : "Not open yet"}
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          {c.winnersPublished
            ? p.winnersShown > 0
              ? "Winners are out — see them below."
              : "Winners have been picked."
            : now != null && challengePhase(c, now) === "judging"
              ? "We're judging entries now. New challenges drop often."
              : "This one has wrapped up. New challenges drop often."}
        </p>
        <Link href="/challenges" className={`${buttonClasses("secondary", "md")} mt-4`}>
          See what&apos;s live
        </Link>
      </>
    );
  } else if (!p.signedIn) {
    body = (
      <>
        <p className="text-sm text-ink-soft">
          Welcome! Register to get updates and {isGiveaway ? "enter" : "submit your project"}.
          It takes a free batch0 account — about 20 seconds.
        </p>
        <Link
          href={`/signup?next=${encodeURIComponent(joinNext)}`}
          onClick={() => markJoinIntent(p.slug)}
          className={`${buttonClasses("primary", "lg")} mt-4 w-full`}
        >
          Register — it&apos;s free
        </Link>
        <p className="mt-3 text-center text-[13px] text-ink-faint">
          Have an account?{" "}
          <Link
            href={`/login?next=${encodeURIComponent(joinNext)}`}
            onClick={() => markJoinIntent(p.slug)}
            className="font-medium text-ink underline decoration-phosphor decoration-2 underline-offset-2"
          >
            Sign in
          </Link>
        </p>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-sm text-ink-soft">
          Welcome{p.viewerName ? `, ${p.viewerName.split(" ")[0]}` : ""}! One click and
          you&apos;re in — we&apos;ll email you the dates and your submission link.
        </p>
        <Button
          size="lg"
          className="mt-4 w-full"
          onClick={register}
          disabled={pending}
        >
          {pending ? "Registering…" : "Register — one click"}
        </Button>
      </>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-paper">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-wash px-4 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-soft">
          {submitted ? "Your entry" : registered ? "You're going" : "Registration"}
        </span>
        {c.closesAt && regOpen && (
          <span className="font-mono text-[12px] text-ink-soft">
            {opensLater && c.opensAt ? (
              <>
                opens in <Countdown to={c.opensAt} className="font-semibold text-ink" />
              </>
            ) : (
              <>
                closes in <Countdown to={c.closesAt} className="font-semibold text-ink" />
              </>
            )}
          </span>
        )}
      </div>
      <div className="p-4 sm:p-5">
        {body}
        {error && (
          <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        {registered && regOpen && !submitted && c.closesAt && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <span className="inline-flex items-center gap-1.5 text-ink-faint">
              <CalendarPlus className="h-3.5 w-3.5" /> Add the deadline:
            </span>
            {p.calendarUrl && (
              <a href={p.calendarUrl} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-line underline-offset-2 hover:decoration-phosphor">
                Google
              </a>
            )}
            <a href={p.icsUrl} className="text-ink underline decoration-line underline-offset-2 hover:decoration-phosphor">
              Apple / Outlook
            </a>
          </div>
        )}

        {p.referral && regOpen && (registered || submitted) && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[13px] font-medium text-ink">
              {c.referralsRequired > 0 && !submitted
                ? `Your referrals: ${Math.min(p.referral.count, c.referralsRequired)} of ${c.referralsRequired}`
                : "Invite friends"}
            </p>
            {c.referralsRequired > 0 && !submitted && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-wash">
                <div
                  className="h-full rounded-full bg-phosphor"
                  style={{
                    width: `${Math.min(100, (p.referral.count / c.referralsRequired) * 100)}%`,
                  }}
                />
              </div>
            )}
            <div className="mt-3">
              <ShareLink url={p.referral.link} compact shareText={`Join me in this batch0 ${p.kindLabel.toLowerCase()}`} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
