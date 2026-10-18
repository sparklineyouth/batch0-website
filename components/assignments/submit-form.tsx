"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { saveAssignmentDraft, submitAssignment } from "@/app/dashboard/assignments/actions";
import { getActionError } from "@/lib/action-error";
import { LIMITS, formatEastern, isGoogleLink, type SubmissionType } from "@/lib/assignments";
import {
  DRAFT_MAX_WAIT_MS,
  DRAFT_SAVE_DELAY_MS,
  draftRetryDelay,
  draftStatusLine,
  isFinalDraftFailure,
  sameWork,
  type DraftSaveResult,
  type DraftStatus,
  type StartingWork,
} from "@/lib/assignment-drafts";

type Work = { body: string; link: string };

const savedTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Hand in or edit one assignment. Used by /dashboard and the installed app.
 *
 * What's typed autosaves as a private draft (lib/assignment-drafts.ts,
 * migration 0105) a couple of seconds after the typing pauses, and when the
 * tab is hidden or closed, so a reload or a dropped phone page restores it.
 * Submit stays the only way to hand work in. The line under the form says
 * what's actually true — saving, saved, failing and retrying, or stopped and
 * why — rather than implying text is safe when it isn't.
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
  actions?: { saveDraft: typeof saveAssignmentDraft; submit: typeof submitAssignment };
}) {
  const saveDraft = actions?.saveDraft ?? saveAssignmentDraft;
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
  const showLink = type !== "text";
  const enabled = autosave === "on";

  // Everything the save loop reads lives in refs, so a timer set during one
  // render still acts on the latest text and version.
  const workRef = useRef<Work>({ body: start.body, link: start.link });
  /** What the server holds for this form: the last saved draft, else what it opened with. */
  const serverRef = useRef<Work>({ body: start.body, link: start.link });
  /** The draft version the next save names (0 = none yet). */
  const versionRef = useRef(start.version);
  const stoppedRef = useRef(false);
  const failingRef = useRef(false);
  const submittingRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number | null>(null);
  const dirtySinceRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  const isDirty = () =>
    workRef.current.body !== serverRef.current.body || workRef.current.link !== serverRef.current.link;
  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  async function saveNow(): Promise<void> {
    if (!enabled || stoppedRef.current || submittingRef.current) return;
    // A save already running may be carrying the latest edit; let it land
    // (and set the version) before deciding whether anything is left.
    while (inFlightRef.current) await inFlightRef.current;
    if (stoppedRef.current || submittingRef.current) return;
    if (!isDirty()) {
      dirtySinceRef.current = null;
      return;
    }
    clearTimer();
    dirtySinceRef.current = null;
    const snapshot = { ...workRef.current };
    setStatus({ kind: "saving" });
    const run = (async () => {
      let result: DraftSaveResult;
      let offline = false;
      try {
        result = await saveDraft({
          assignmentId,
          body: snapshot.body,
          linkUrl: showLink ? snapshot.link : null,
          baseVersion: versionRef.current,
        });
      } catch {
        // The request itself failed: offline, or a deploy swapped the action.
        offline = typeof navigator !== "undefined" && navigator.onLine === false;
        result = { ok: false, reason: "error" };
      }
      if (result.ok) {
        versionRef.current = result.version;
        serverRef.current = snapshot;
        attemptRef.current = 0;
        failingRef.current = false;
        setStatus({ kind: "saved", at: result.savedAt });
        if (isDirty()) schedule();
        return;
      }
      if (isFinalDraftFailure(result.reason)) {
        // Another try would be refused the same way: stale, closed, signed
        // out… Stop, and say so.
        stoppedRef.current = true;
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
    schedule();
  }

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

  // When autosave has said it isn't keeping up, closing the tab asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const atRisk = autosave === "failed" || stoppedRef.current || failingRef.current;
      if (!atRisk || submittingRef.current || !isDirty()) return;
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
    if (
      status.kind === "stopped" &&
      status.reason === "stale" &&
      !window.confirm(
        "Newer text was saved in another tab or on another device. Submit what's in this tab anyway?",
      )
    ) {
      return;
    }
    submittingRef.current = true;
    clearTimer();
    startTransition(async () => {
      try {
        // Let an autosave that's mid-flight land, so its version is the one
        // the submit clears.
        while (inFlightRef.current) await inFlightRef.current;
        const snapshot = { ...workRef.current };
        const res = await submitWork({
          assignmentId,
          body: snapshot.body,
          linkUrl: showLink ? snapshot.link : null,
          draftVersion: versionRef.current,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        versionRef.current = res.data?.draftVersion ?? versionRef.current;
        serverRef.current = snapshot;
        dirtySinceRef.current = null;
        setHandedIn(snapshot);
        setSaved(true);
        if (!stoppedRef.current && enabled) setStatus({ kind: "idle" });
        router.refresh();
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
  const line = saved
    ? null
    : draftStatusLine(status, {
        handedIn: !!handedIn,
        unsubmitted: !sameWork({ body, link: showLink ? link : "" }, handedIn),
        // A restored draft's time renders on the server too: program time
        // keeps the two renders identical. A save's is only ever local.
        formatTime: (iso) => (status.kind === "restored" ? formatEastern(iso) : savedTime(iso)),
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
