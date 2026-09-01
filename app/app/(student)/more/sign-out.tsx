"use client";
import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";

/**
 * Sign out, gated behind a second tap.
 *
 * This is the widest tappable thing on the More screen, it sits at the very
 * bottom of a long scroll, and directly above it is the install banner's
 * dismiss control — so a miss lands here. On the web that costs a redirect back
 * through the password form. Inside an installed app it costs a great deal
 * more: re-authenticating means an emailed magic link, which means leaving the
 * standalone window for the mail client and then for Safari, and the person may
 * never find their way back to the home-screen icon in the same session.
 *
 * The confirmation is a label swap rather than a dialog. A dialog on a phone is
 * a modal layer, a focus trap and a second set of 44px targets for a decision
 * that has exactly two outcomes; the button already occupies the full width and
 * can simply say what the next tap will do. It disarms itself after four
 * seconds so a stray first tap does not leave a loaded control sitting on the
 * screen for the rest of the session.
 *
 * The <form> is still a real POST to /auth/signout, unchanged: that route
 * rejects cross-origin posts, so a fetch() or a link would be refused. The
 * second tap hands off to `requestSubmit()`, which submits the form the way the
 * browser would — validation, submit event and all — instead of this component
 * re-implementing a request it has no business owning.
 */
export function SignOut() {
  const formRef = useRef<HTMLFormElement>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <form ref={formRef} action="/auth/signout" method="post" className="mt-7">
      <button
        // Not type="submit": the first tap must be incapable of posting, and a
        // submit button that only sometimes submits is one preventDefault away
        // from signing someone out by accident.
        type="button"
        onClick={() => {
          if (armed) formRef.current?.requestSubmit();
          else setArmed(true);
        }}
        className={`press inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-wash text-[14px] font-medium active:scale-[0.99] ${
          armed
            ? "border-red-500/30 text-red-600 dark:text-red-300"
            : "border-line text-ink-soft"
        }`}
      >
        <LogOut className="h-4 w-4" />
        {armed ? "Tap again to sign out" : "Sign out"}
      </button>
      {/* Announced rather than shown: the label above already carries the
          change visually, but a screen reader user who has moved focus off the
          button would otherwise get no signal that it is now armed. */}
      <span aria-live="polite" className="sr-only">
        {armed ? "Confirm sign out. Tap the button again." : ""}
      </span>
      {/* The control above needs JavaScript to arm, so between first paint and
          hydration — and forever with JS off — it does nothing. What it
          replaced was a plain form POST that always worked, so without this
          the confirm gate would have been bought with a capability. <noscript>
          is inert once React is running, so the armed path is unaffected. */}
      <noscript>
        <button
          type="submit"
          className="press mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-wash text-[14px] font-medium text-ink-soft"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </noscript>
    </form>
  );
}
