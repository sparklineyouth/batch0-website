"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { submitAssignment } from "@/app/dashboard/assignments/actions";
import { getActionError } from "@/lib/action-error";
import { LIMITS, formatEastern, isGoogleLink, type SubmissionType } from "@/lib/assignments";
import {
  DRAFT_MAX_WAIT_MS,
  DRAFT_SAVE_DELAY_MS,
  draftRetryDelay,
  draftStatusLine,
  isFinalDraftFailure,
  reconcileDraft,
  sameWork,
  type DraftFailure,
  type DraftSaveResult,
  type DraftState,
  type DraftStatus,
  type SentWork,
  type StartingWork,
} from "@/lib/assignment-drafts";
import { loadDraftOverHttp, saveDraftOverHttp, type DraftSaveInput } from "@/lib/assignment-drafts-client";

type Work = { body: string; link: string };

/** How the form reaches the server. The pages use the defaults; app/dev/assignment passes a stand-in. */
export type DraftTransport = {
  saveDraft: (input: DraftSaveInput) => Promise<DraftSaveResult>;
  loadDraft: (assignmentId: string) => Promise<DraftState | null>;
  submit: typeof submitAssignment;
};

const STALE_CONFIRM =
  "Newer work was saved or submitted in another tab or on another device. Submit what's in this tab instead?";

const savedTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Hand in or edit one assignment. Used by /dashboard and the installed app.
 *
 * What's typed autosaves as a private draft (lib/assignment-drafts.ts,
 * migration 0105) a couple of seconds after the typing pauses, and when the
 * tab is hidden, closed or navigated away from — as a keepalive request, which
 * the browser finishes after the page is gone — so a reload or a dropped
 * phone page restores it. Submit stays the only way to hand work in. The line
 * under the form says what's actually true — saving, saved, failing and
 * retrying, or stopped and why — rather than implying text is safe when it
 * isn't: an edit not yet saved reads "Saving draft…", never "Draft saved".
 *
 * The props can be out of date. Back/Forward renders this page from the
 * router cache, so the form re-reads the draft once it mounts and takes the
 * newer text if nothing has been typed here yet (reconcileDraft). A "stale"
 * answer re-reads it too before giving up: that can be this tab's own save
 * or submit whose answer was lost on a dropped connection.
 *
 * `autosave` is "off" before 0105 runs: the form then behaves exactly as it
 * did before drafts existed. `actions` exists for app/dev/assignment, whose
 * fixtures stand in for the server; the pages never pass it.
 */
export function SubmitForm({
  assignmentId,
  type,
  initial,
  start,
  autosave,
  pastDue,
  actions,
}: {
  assignmentId: string;
  type: SubmissionType;
  /** What was handed in, if anything. */
  initial: { body: string; link: string } | null;
  /** What the form opens with: the newer of the draft and the submission. */
  start: StartingWork;
  autosave: "on" | "off" | "failed";
  pastDue: boolean;
  actions?: DraftTransport;
}) {
  const saveDraft = actions?.saveDraft ?? saveDraftOverHttp;
  const loadDraft = actions?.loadDraft ?? loadDraftOverHttp;
  const submitWork = actions?.submit ?? submitAssignment;
  const router = useRouter();
  const [body, setBody] = useState(start.body);
  const [link, setLink] = useState(start.link);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  // What reviewers see, kept current after a submit without waiting for the
  // refresh.
  const [handedIn, setHandedIn] = useState<Work | null>(initial);
  const [status, setStatus] = useState<DraftStatus>(() =>
    autosave === "failed"
      ? { kind: "load_failed" }
      : autosave !== "on"
        ? { kind: "off" }
        : start.restoredAt
          ? { kind: "restored", at: start.restoredAt }
          : { kind: "idle" },
  );
  /** The text differs from what the server holds: a save is due or on its way. */
  const [dirty, setDirty] = useState(false);
  const showLink = type !== "text";
  const enabled = autosave === "on";

  /** The form's text as a save or submit sends it. */
  const sent = (w: Work): SentWork => ({ body: w.body, link: showLink ? w.link : "" });

  // Everything the save loop reads lives in refs, so a timer set during one
  // render still acts on the latest text and version.
  const workRef = useRef<Work>({ body: start.body, link: start.link });
  /** What the server holds for this form: the last saved draft, else what it opened with. */
  const serverRef = useRef<SentWork>(sent({ body: start.body, link: start.link }));
  /** The draft version the next save names (0 = none yet). */
  const versionRef = useRef(start.version);
  const stoppedRef = useRef<DraftFailure | null>(null);
  const failingRef = useRef(false);
  const submittingRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number | null>(null);
  const dirtySinceRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  /** A save that got no answer (it may have landed): what it sent. */
  const unconfirmedRef = useRef<SentWork | null>(null);
  /** A submit that got no answer (it may have gone through): what it sent. */
  const pendingSubmitRef = useRef<SentWork | null>(null);

  const isDirty = () => {
    const now = sent(workRef.current);
    return now.body !== serverRef.current.body || now.link !== serverRef.current.link;
  };
  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Show `next` as the form's text: the draft or submission as they stand now. */
  function adopt(next: StartingWork, nextHandedIn: Work | null) {
    const w = { body: next.body, link: next.link };
    workRef.current = w;
    serverRef.current = sent(w);
    versionRef.current = next.version;
    unconfirmedRef.current = null;
    setBody(w.body);
    setLink(w.link);
    setHandedIn(nextHandedIn);
    setDirty(false);
    setStatus(next.restoredAt ? { kind: "restored", at: next.restoredAt } : { kind: "idle" });
  }

  /**
   * Read the draft again and bring this tab up to date where that's safe.
   * True when the tab is now in step and may carry on saving; false when the
   * newer text would be overwritten (or couldn't be read), which is the
   * student's call. After a submit with no answer (`afterSubmit`) only "it
   * went through" or "a save of ours landed" apply: replacing the text the
   * student just tried to hand in with another tab's would be no answer.
   */
  async function catchUp(afterSubmit = false): Promise<boolean> {
    const remote = await loadDraft(assignmentId).catch(() => null);
    if (!remote || remote.state !== "ready") return false;
    const r = reconcileDraft(
      {
        version: versionRef.current,
        base: serverRef.current,
        work: sent(workRef.current),
        unconfirmed: unconfirmedRef.current,
        pendingSubmit: pendingSubmitRef.current,
      },
      remote,
    );
    switch (r.kind) {
      case "landed":
        // A save of ours went through after all: build on it.
        versionRef.current = r.version;
        serverRef.current = r.text;
        unconfirmedRef.current = null;
        setDirty(isDirty());
        setStatus({ kind: "saved", at: r.savedAt });
        return true;
      case "submitted": {
        const handed = pendingSubmitRef.current!;
        pendingSubmitRef.current = null;
        versionRef.current = r.version;
        serverRef.current = handed;
        setHandedIn(handed);
        setError(null);
        setDirty(isDirty());
        setSaved(!isDirty());
        if (stoppedRef.current === "stale") stoppedRef.current = null;
        if (!stoppedRef.current) setStatus({ kind: "idle" });
        router.refresh();
        return true;
      }
      case "adopt":
        if (afterSubmit) return false;
        adopt(r.start, r.handedIn);
        return true;
      default:
        return false;
    }
  }

  async function saveNow(): Promise<void> {
    if (!enabled || stoppedRef.current || submittingRef.current) return;
    // A save already running may be carrying the latest edit; let it land
    // (and set the version) before deciding whether anything is left.
    while (inFlightRef.current) await inFlightRef.current;
    if (stoppedRef.current || submittingRef.current) return;
    if (!isDirty()) {
      dirtySinceRef.current = null;
      setDirty(false);
      return;
    }
    clearTimer();
    dirtySinceRef.current = null;
    const snapshot = sent(workRef.current);
    setStatus({ kind: "saving" });
    const run = (async () => {
      let result: DraftSaveResult;
      let offline = false;
      try {
        // Called before any await (lib/assignment-drafts-client.ts), so a
        // save started as the page closes is already on its way.
        result = await saveDraft({
          assignmentId,
          body: snapshot.body,
          linkUrl: showLink ? snapshot.link : null,
          baseVersion: versionRef.current,
        });
      } catch {
        // The request itself failed: offline, or the connection dropped.
        offline = typeof navigator !== "undefined" && navigator.onLine === false;
        result = { ok: false, reason: "error" };
      }
      if (result.ok) {
        versionRef.current = result.version;
        serverRef.current = snapshot;
        unconfirmedRef.current = null;
        attemptRef.current = 0;
        failingRef.current = false;
        setStatus({ kind: "saved", at: result.savedAt });
        setDirty(isDirty());
        if (isDirty()) schedule();
        return;
      }
      // An error may still have been written (the answer, not the save, was
      // lost); if a later save is refused as stale, this is how it's known.
      if (result.reason === "error") unconfirmedRef.current = snapshot;
      // "Stale" can be this tab merely behind — Back showed an old copy, or
      // an earlier save landed without telling us. Only a real conflict stops.
      if (result.reason === "stale" && (await catchUp())) {
        attemptRef.current = 0;
        failingRef.current = false;
        if (isDirty()) schedule();
        return;
      }
      if (isFinalDraftFailure(result.reason)) {
        // Another try would be refused the same way: stale, closed, signed
        // out… Stop, and say so.
        stoppedRef.current = result.reason;
        failingRef.current = false;
        clearTimer();
        setStatus({ kind: "stopped", reason: result.reason });
        return;
      }
      failingRef.current = true;
      setStatus({ kind: "retrying", reason: result.reason, offline });
      const delay = draftRetryDelay(attemptRef.current, result.reason);
      attemptRef.current += 1;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void saveRef.current();
      }, delay);
    })();
    inFlightRef.current = run;
    try {
      await run;
    } finally {
      if (inFlightRef.current === run) inFlightRef.current = null;
    }
  }
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  /** Save after a pause in typing — or, typing without pause, every DRAFT_MAX_WAIT_MS. */
  function schedule() {
    if (!enabled || stoppedRef.current) return;
    const now = Date.now();
    dirtySinceRef.current ??= now;
    const wait = Math.max(0, Math.min(DRAFT_SAVE_DELAY_MS, dirtySinceRef.current + DRAFT_MAX_WAIT_MS - now));
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void saveRef.current();
    }, wait);
  }

  function edit(next: Partial<Work>) {
    workRef.current = { ...workRef.current, ...next };
    if (next.body !== undefined) setBody(next.body);
    if (next.link !== undefined) setLink(next.link);
    setSaved(false);
    setDirty(isDirty());
    schedule();
  }

  // The page may have come out of the router cache (Back/Forward), older than
  // the draft: read it again now, and take the newer text if nothing has been
  // typed here yet. A save or submit already running sorts itself out (a
  // stale answer reads it again).
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      const remote = await loadDraft(assignmentId).catch(() => null);
      if (!live || !remote || remote.state !== "ready") return;
      if (inFlightRef.current || submittingRef.current || stoppedRef.current) return;
      const r = reconcileDraft(
        { version: versionRef.current, base: serverRef.current, work: sent(workRef.current) },
        remote,
      );
      if (r.kind === "adopt") adopt(r.start, r.handedIn);
      else if (r.kind === "landed") {
        versionRef.current = r.version;
        serverRef.current = r.text;
        setDirty(isDirty());
      }
    })();
    return () => {
      live = false;
    };
    // Refs only; enabled and the assignment are fixed for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, assignmentId]);

  // A hidden tab, a backgrounded phone or a closed page saves what's there
  // now rather than waiting out the typing pause. Leaving the page inside the
  // app (unmount) does the same.
  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      if (isDirty()) void saveRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimer();
      flush();
    };
    // Refs only; enabled is fixed for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Closing or reloading with text the server doesn't have yet: send it now
  // (a keepalive request, finished after the page is gone) and let the page
  // go. Ask first only when that can't be relied on — saves are failing or
  // stopped, a save is still running with newer text queued behind it, or a
  // submit is on its way (an ordinary request, which leaving cancels).
  useEffect(() => {
    if (autosave === "off") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const atRisk = autosave === "failed" || !!stoppedRef.current || failingRef.current;
      let ask = submittingRef.current;
      if (isDirty()) {
        if (atRisk || inFlightRef.current) ask = true;
        else void saveRef.current();
      }
      if (!ask) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave]);

  function submit() {
    setError(null);
    setSaved(false);
    let force = false;
    if (stoppedRef.current === "stale") {
      if (!window.confirm(STALE_CONFIRM)) return;
      force = true;
    }
    submittingRef.current = true;
    clearTimer();
    startTransition(async () => {
      try {
        // Let an autosave that's mid-flight land, so the version this sends
        // is the one it left.
        while (inFlightRef.current) await inFlightRef.current;
        for (;;) {
          const snapshot = sent(workRef.current);
          let res: Awaited<ReturnType<typeof submitWork>>;
          try {
            res = await submitWork({
              assignmentId,
              body: snapshot.body,
              linkUrl: showLink ? snapshot.link : null,
              // null: no autosave here, so nothing to compare (as before 0105).
              draftVersion: enabled ? versionRef.current : null,
              force,
            });
          } catch (e) {
            // No answer: it may have gone through. Reading the draft back
            // tells (a submit clears it); otherwise say it failed.
            pendingSubmitRef.current = snapshot;
            if (enabled && (await catchUpRef.current(true)) && !pendingSubmitRef.current) return;
            setError(getActionError(e));
            return;
          }
          if (!res.ok) {
            setError(res.error);
            return;
          }
          if (res.data?.outcome === "stale") {
            // Newer work from elsewhere that this tab never saw. Handing this
            // in would replace it, so ask; declining leaves both alone, and
            // this tab stops saving over it too.
            if (!force && window.confirm(STALE_CONFIRM)) {
              force = true;
              continue;
            }
            stoppedRef.current = "stale";
            failingRef.current = false;
            setStatus({ kind: "stopped", reason: "stale" });
            return;
          }
          pendingSubmitRef.current = null;
          unconfirmedRef.current = null;
          if (res.data) versionRef.current = res.data.draftVersion;
          serverRef.current = snapshot;
          dirtySinceRef.current = null;
          setHandedIn(snapshot);
          setSaved(true);
          setDirty(isDirty());
          // A tab stopped as stale is in step again once its text is the
          // submission and it holds the version the submit left.
          if (stoppedRef.current === "stale") stoppedRef.current = null;
          if (!stoppedRef.current && enabled) setStatus({ kind: "idle" });
          router.refresh();
          return;
        }
      } catch (e) {
        setError(getActionError(e));
      } finally {
        submittingRef.current = false;
        // Anything typed while it was submitting still needs saving.
        if (isDirty()) schedule();
      }
    });
  }

  const driveHint = showLink && link.trim() && isGoogleLink(link.trim());
  // Typed but not saved yet reads as saving, never as the last save's "saved".
  const shown: DraftStatus =
    enabled && dirty && (status.kind === "idle" || status.kind === "restored" || status.kind === "saved")
      ? { kind: "saving" }
      : status;
  const line = saved
    ? null
    : draftStatusLine(shown, {
        handedIn: !!handedIn,
        unsubmitted: !sameWork({ body, link: showLink ? link : "" }, handedIn),
        // A restored draft's time renders on the server too: program time
        // keeps the two renders identical. A save's is only ever local.
        formatTime: (iso) => (shown.kind === "restored" ? formatEastern(iso) : savedTime(iso)),
      });

  return (
    <div className="space-y-4">
      {showLink && (
        <div>
          <Label htmlFor="assignment-link">{type === "link" ? "Link" : "Link (optional)"}</Label>
          <Input
            id="assignment-link"
            type="url"
            inputMode="url"
            placeholder="https://docs.google.com/…"
            value={link}
            maxLength={LIMITS.link}
            onChange={(e) => edit({ link: e.target.value })}
          />
          <p className="mt-1 text-xs text-ink-faint">
            {driveHint
              ? "Set sharing to “Anyone with the link can view”."
              : "Google Drive or Docs links work best."}
          </p>
        </div>
      )}
      <div>
        <Label htmlFor="assignment-body">
          {type === "text" ? "Your answer" : type === "link" ? "Note (optional)" : "Your answer (or a link above)"}
        </Label>
        <Textarea
          id="assignment-body"
          rows={type === "link" ? 3 : 8}
          value={body}
          maxLength={LIMITS.body}
          onChange={(e) => edit({ body: e.target.value })}
        />
        {line && (
          <p
            aria-live={line.tone === "bad" ? "polite" : "off"}
            className={`mt-1 text-xs ${line.tone === "bad" ? "text-red-600 dark:text-red-400" : "text-ink-faint"}`}
          >
            {line.text}
          </p>
        )}
      </div>
      <FieldError>{error}</FieldError>
      {saved && !error && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">Submitted.</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          {pastDue ? "Past due — it'll be marked late." : "You can edit until it's reviewed."}
        </p>
        <Button onClick={submit} disabled={pending}>
          {pending ? "Submitting…" : handedIn ? "Update" : "Submit"}
        </Button>
      </div>
    </div>
  );
}
