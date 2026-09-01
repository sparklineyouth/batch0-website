"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Trophy } from "lucide-react";
import { submitCheckin } from "@/app/dashboard/checkin/actions";
import { getActionError } from "@/lib/action-error";

/**
 * An unsent draft, keyed by the ISO week it belongs to.
 *
 * Keyed, not global: an abandoned draft from three weeks ago must never
 * resurface on top of the week you are actually writing.
 */
const DRAFT_PREFIX = "batch0:checkin-draft:";
type Draft = {
  accomplished: string;
  next_up: string;
  blockers: string;
  is_milestone: boolean;
};

/**
 * The weekly check-in, phone-sized.
 *
 * It calls the same `submitCheckin` server action as /dashboard/checkin — not a
 * mobile copy of it. That action carries the enrollment check, the pre-cohort
 * gate, the 4000-character cap, the #wins cross-post and the staff fan-out; a
 * parallel implementation would drift from all six, and the failure would be
 * silent (check-ins that never notify a mentor read exactly like check-ins
 * nobody replied to).
 *
 * The upsert is on (user_id, week_start), so re-submitting edits this week's
 * entry rather than creating a second one. That's why the form is prefilled and
 * the button says "Update" once something exists — the alternative is a student
 * assuming they've double-posted.
 */
export function CheckinForm({
  initial,
  weekLabel,
  weekStart,
}: {
  initial: {
    accomplished: string;
    next_up: string;
    blockers: string;
    is_milestone: boolean;
  } | null;
  weekLabel: string;
  /** Monday of the week being written, YYYY-MM-DD. Keys the local draft. */
  weekStart: string;
}) {
  const [accomplished, setAccomplished] = useState(initial?.accomplished ?? "");
  const [nextUp, setNextUp] = useState(initial?.next_up ?? "");
  const [blockers, setBlockers] = useState(initial?.blockers ?? "");
  const [milestone, setMilestone] = useState(initial?.is_milestone ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const draftKey = `${DRAFT_PREFIX}${weekStart}`;

  // The server's own copy, as primitives. Held separately so the persistence
  // effect can compare against it without taking the `initial` OBJECT as a
  // dependency — that prop is rebuilt on every server render, so it would
  // re-run the effect on identity alone.
  const serverAccomplished = initial?.accomplished ?? "";
  const serverNextUp = initial?.next_up ?? "";
  const serverBlockers = initial?.blockers ?? "";
  const serverMilestone = initial?.is_milestone ?? false;

  // Mirrors the server's own rule rather than inventing a stricter one: the
  // action rejects a check-in where all three sections are blank.
  const empty = !accomplished.trim() && !nextUp.trim() && !blockers.trim();

  // Restore an unsent draft.
  //
  // Everything typed here used to live only in component state, and this is a
  // standalone web app on a phone: one thumb landing on the tab bar below the
  // submit button, one incoming call, one iOS decision to reclaim a
  // backgrounded web view, and three paragraphs were gone with no warning.
  //
  // Read in an effect rather than in useState's initialiser because the
  // component is server-rendered first — localStorage does not exist there, so
  // seeding state from it would hydrate against markup the server never wrote.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<Draft>;
      if (typeof d.accomplished === "string") setAccomplished(d.accomplished);
      if (typeof d.next_up === "string") setNextUp(d.next_up);
      if (typeof d.blockers === "string") setBlockers(d.blockers);
      if (typeof d.is_milestone === "boolean") setMilestone(d.is_milestone);
    } catch {
      // Private mode, blocked storage, or a key someone else wrote. Falling
      // back to the server's copy is the safe failure.
    }
  }, [draftKey]);

  // Persist it. The timeout is the debounce: up to 12000 characters serialised
  // on every keystroke is real main-thread work on a mid-range phone, and the
  // effect's own cleanup cancels the pending write for free.
  //
  // Only when it actually differs from the server's copy, and the key is
  // REMOVED when it doesn't. Writing unconditionally meant simply opening this
  // screen and typing nothing left a draft behind, and that draft outlives the
  // render it was copied from: post from a laptop, come back to the phone, and
  // the restore above would put the older text back into the fields and the
  // next "Update check-in" would overwrite the newer answer with it. A draft
  // that nobody typed has nothing to protect and can only go stale.
  useEffect(() => {
    const dirty =
      accomplished !== serverAccomplished ||
      nextUp !== serverNextUp ||
      blockers !== serverBlockers ||
      milestone !== serverMilestone;
    const t = setTimeout(() => {
      try {
        if (!dirty) {
          localStorage.removeItem(draftKey);
          return;
        }
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            accomplished,
            next_up: nextUp,
            blockers,
            is_milestone: milestone,
          } satisfies Draft),
        );
      } catch {
        // Quota or private mode. The draft is a safety net, never the source
        // of truth, so failing to write it must not interrupt writing.
      }
    }, 400);
    return () => clearTimeout(t);
  }, [
    draftKey,
    accomplished,
    nextUp,
    blockers,
    milestone,
    serverAccomplished,
    serverNextUp,
    serverBlockers,
    serverMilestone,
  ]);

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await submitCheckin({
          accomplished,
          next_up: nextUp,
          blockers,
          is_milestone: milestone,
        });
        setSaved(true);
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // Nothing to do — the draft is stale, not dangerous.
        }
        // The button label and the header's Due/Posted badge both come from
        // the server render (`initial` is a prop and never changes), so
        // without this a successful save leaves the screen saying "Post
        // check-in" and "Due" until a manual reload. The route is
        // force-dynamic, so this is one fetch, not a cache cascade.
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      <Field
        label="What you shipped"
        hint="Concrete things. “Talked to 6 users”, not “made progress”."
        value={accomplished}
        onChange={setAccomplished}
        placeholder="Shipped the landing page, ran 6 customer interviews…"
      />
      <Field
        label="What's next"
        hint="The single most important thing for the coming week."
        value={nextUp}
        onChange={setNextUp}
        placeholder="Get 10 signups from the waitlist…"
      />
      <Field
        label="What's blocking you"
        hint="This is the part mentors actually read. Say the real thing."
        value={blockers}
        onChange={setBlockers}
        placeholder="Can't decide between two pricing models…"
      />

      <button
        type="button"
        onClick={() => setMilestone((m) => !m)}
        aria-pressed={milestone}
        className={`press flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left active:scale-[0.99] ${
          milestone
            ? "border-phosphor/40 bg-phosphor/[0.08]"
            : "border-line bg-wash"
        }`}
      >
        <Trophy
          className={`h-4 w-4 shrink-0 ${
            milestone ? "text-phosphor-ink" : "text-ink-faint"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-tight text-ink">
            This was a milestone
          </span>
          <span className="mt-1 block text-[12px] leading-snug text-ink-soft">
            Cross-posts to #wins in Discord for the whole cohort to see.
          </span>
        </span>
        <span
          className={`h-5 w-5 shrink-0 rounded-md border ${
            milestone
              ? "border-phosphor bg-phosphor"
              : "border-line bg-paper"
          }`}
        >
          {milestone && <Check className="h-[18px] w-[18px] text-on-phosphor" />}
        </span>
      </button>

      {/* These two are the canonical outcome, and they carry the live regions —
          but they sit at the end of a form that is hundreds of pixels tall, so
          on a phone they are off-screen for anyone who submits from the sticky
          bar mid-form. The one-line echo inside that bar is what a sighted
          reader actually sees; this pair is what gets announced. */}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {saved && !error && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300"
        >
          Saved for {weekLabel}. Your mentors have been pinged.
        </p>
      )}

      {/* Sticky above the tab bar: the three fields are long enough on a phone
          that a button at the bottom of the document is off-screen for the whole
          time you're writing.

          The offset clears the bar rather than sitting inside it. At the old
          3.5rem it assumed a 56px bar; the bar is 3.75rem (tab-bar.tsx, and
          frame.tsx reserves the same), which left the button's bottom edge 8px
          above a 60px nav target — and the tab directly under it is "Check in",
          this page, so a low thumb navigated instead of submitting. The extra
          0.5rem is a deliberate gutter. The fallback in var() is there because
          --tab-bar-h is being promoted into globals.css alongside --safe-bottom;
          without a fallback an unresolved var invalidates the whole calc() and
          the bar drops to the bottom of the document. */}
      <div className="sticky bottom-[calc(var(--tab-bar-h,3.75rem)+var(--safe-bottom)+0.5rem)] -mx-5 border-t border-line bg-paper/95 px-5 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <button
          type="button"
          onClick={save}
          disabled={pending || empty}
          aria-busy={pending}
          className="press inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-md bg-phosphor text-[14px] font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
        >
          {pending
            ? "Saving…"
            : initial
              ? "Update check-in"
              : "Post check-in"}
        </button>
        {/* One line, always rendered, with its height reserved whether or not
            there is anything to say. Rendering it conditionally would grow the
            bar at the moment of the tap and push the button up under a thumb
            that is already travelling. aria-hidden: the messages above are the
            live regions, and announcing the same outcome twice is worse than
            not announcing it here at all. */}
        <p
          aria-hidden
          className={`mt-2 min-h-[1.25rem] truncate text-center text-[11px] leading-5 ${
            error
              ? "text-red-600 dark:text-red-300"
              : saved
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-ink-faint"
          }`}
        >
          {error
            ? error
            : saved
              ? "Saved. Your mentors have been pinged."
              : empty
                ? "Fill in at least one section."
                : ""}
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to fit what has been written.
  //
  // The field used to be `rows={3}` plus `resize-y`, which on the only device
  // this app targets is three fixed lines: iOS Safari draws no resize grabber,
  // so the handle the class promises does not exist. Against a 4000-character
  // cap that meant re-reading a long answer through a 72px window, inside the
  // page scroll.
  //
  // The cap is measured against `visualViewport`, never `vh`. On iOS `vh`
  // resolves against the LARGE viewport, so a "60vh" ceiling is taller than
  // everything you can actually see once the keyboard is up — the field would
  // grow straight past the sticky submit bar. Half of the *visible* height
  // leaves the bar and the next field on screen; the 22rem is the fallback for
  // browsers without visualViewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const visible = window.visualViewport?.height ?? window.innerHeight;
    const cap = Math.min(visible * 0.5, 22 * 16);
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [value]);

  return (
    <label className="block">
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
        {label}
      </span>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // The floor, and the whole height until the effect runs.
        rows={3}
        // Multiline, so Return still inserts a newline — this only stops the
        // key from reading as "go" on a field where it does not submit.
        enterKeyHint="done"
        // 4000 is the server's cap. Enforcing it here too means the limit is a
        // thing the keyboard stops at rather than an error after the fact.
        maxLength={4000}
        // 16px, not 15: iOS Safari zooms the whole viewport when a focused
        // control's text is under 16px, and the zoom does not undo itself on
        // blur — so a student posting a check-in is left in a magnified app
        // with the tab bar and header scaled and clipped. globals.css sets
        // text-size-adjust, but that governs text inflation, not focus zoom;
        // only the font size does. resize-none because the grabber it enabled
        // does not exist on iOS and the effect above owns the height now.
        className="mt-2 block w-full resize-none overflow-y-auto rounded-xl border border-line bg-wash px-3.5 py-3 text-[16px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
      />
      <span className="mt-1.5 block text-[11px] leading-snug text-ink-faint">
        {hint}
      </span>
    </label>
  );
}
