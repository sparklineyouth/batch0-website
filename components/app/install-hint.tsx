"use client";
import { useEffect, useState } from "react";
import { Share, X, Download } from "lucide-react";

const DISMISS_KEY = "batch0:install-hint-dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * "Add this to your home screen" — the two halves of it.
 *
 * The two platforms need genuinely different treatment, which is why this is
 * one component with two branches rather than a single generic banner:
 *
 *   Android/Chromium fires `beforeinstallprompt`, which we capture and replay
 *   from a real button. That gives a native install dialog and an actual
 *   installed app.
 *
 *   iOS Safari fires nothing and exposes no install API at all. The only route
 *   is Share → Add to Home Screen, performed by hand, so the honest thing to
 *   show there is instructions. This is exactly the gap that makes a
 *   Gradescout-style install feel like folklore — nobody discovers that menu
 *   item on their own.
 *
 * Nothing renders once the app is already installed (`display-mode: standalone`
 * on both platforms, plus `navigator.standalone` for older iOS), or once the
 * hint has been dismissed. The dismissal is localStorage, not a cookie: it is
 * per-device UI state, and a cookie would ride along on every request to the
 * origin for something the server has no opinion about.
 */
export function InstallHint() {
  const [platform, setPlatform] = useState<"ios" | "prompt" | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Already installed — the whole component is moot.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      // Private mode / storage blocked. Showing the hint is the safe failure.
    }

    const onPrompt = (e: Event) => {
      // Suppress Chrome's own mini-infobar so there is one install affordance
      // rather than two competing ones, then keep the event to replay later.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setPlatform("prompt");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS: no event is ever coming, so decide from the UA. Excluding
    // "CriOS"/"FxiOS" matters — Chrome and Firefox on iOS cannot add to the
    // home screen at all, so the Share-sheet instructions would be a lie.
    const ua = window.navigator.userAgent;
    const isIosSafari =
      /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    if (isIosSafari) setPlatform("ios");

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* nothing to do; the hint just returns next session */
    }
    setPlatform(null);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // Whatever they chose, this event is spent — it cannot be prompted twice.
    setDeferred(null);
    dismiss();
  }

  if (!platform) return null;

  return (
    <div className="relative rounded-xl border border-phosphor/30 bg-phosphor/[0.06] px-4 py-3.5 pr-10">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="press absolute right-2 top-2 rounded-md p-1.5 text-ink-faint hover:bg-wash hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {platform === "ios" ? (
        <>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-phosphor-ink">
            Add to home screen
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-relaxed text-ink-soft">
            Tap
            <Share className="inline h-3.5 w-3.5 shrink-0 text-ink" aria-label="the Share button" />
            in Safari, then
            <span className="font-medium text-ink">Add to Home Screen</span>.
            batch0 opens full screen, like an app.
          </p>
        </>
      ) : (
        <>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-phosphor-ink">
            Install batch0
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
            Put it on your home screen and it opens full screen, like an app.
          </p>
          <button
            type="button"
            onClick={install}
            className="press mt-3 inline-flex h-9 select-none items-center gap-2 rounded-md bg-phosphor px-3.5 text-[13px] font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] hover:bg-phosphor-200"
          >
            <Download className="h-3.5 w-3.5" />
            Install
          </button>
        </>
      )}
    </div>
  );
}
