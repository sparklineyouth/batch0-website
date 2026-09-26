"use client";
import { track } from "@vercel/analytics";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type HTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Loader2,
} from "lucide-react";
import { Wordmark } from "@/components/wordmark";
import { seedAnswers } from "@/components/forms/custom-question-fields";
import { REF_STORAGE_KEY, readRefFromLocation } from "@/lib/referral-code";
import {
  CUSTOM_PREFIX,
  SCHOLARSHIP_PREFIX,
  formatAnswer,
  hasOptions,
  readAnswers,
  type CustomQuestion,
} from "@/lib/question-schema";
import type { MergedQuestion } from "@/lib/application-fields";
import type { Application } from "@/lib/types";
import {
  FORM_KEYS,
  LINK_KEYS,
  LOCATION_KEYS,
  MAX_LENGTH,
  QUICK_PICKS,
  SECTION_LABELS,
  WHY_MIN,
  buildQuestionMap,
  buildScreens,
  choiceKey,
  emptyForm,
  firstName,
  isMinor,
  isRequired,
  isVisible,
  postableForm,
  promptFor,
  resumeIndex,
  screenFieldNames,
  screenHasAnswer,
  validateAll,
  validateScreen,
  withScheme,
  type AnswerState,
  type FormKey,
  type FormState,
  type QuestionMap,
  type Screen,
  type ValidationContext,
} from "@/lib/apply-flow";
import {
  attachReferralCodeAction,
  saveDraftAction,
  submitApplicationAction,
} from "./actions";
import { IdeaValidator } from "./idea-validate";

// ---------------------------------------------------------------------------
// /apply, one question at a time.
//
// The screen list, the per-screen rules and the whole-form check live in
// lib/apply-flow.ts (pure, tested). This file is only the experience: moving
// between screens, keyboard shortcuts, autosave, and the submit round trip.
//
// Screens are tracked by ID, not index. The list changes under the applicant —
// answering "16" to age inserts the parent/guardian question right after it —
// and an index would silently point at a different question when it did.
// ---------------------------------------------------------------------------

export type CohortOption = {
  id: string;
  name: string;
  /** "Dec 14, 2026 – Feb 12, 2027" */
  dates: string;
  weeks: number | null;
  priceLabel: string;
  /** Started already; admitting late under a catch-up plan. */
  lateEntry: boolean;
  /** "Applications close Dec 12" / "Late entry ends Sep 22" — or "". */
  deadlineLabel: string;
  catchUpPlan: string | null;
  capacity: number;
};

type Mode = "new" | "draft" | "reapply";

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type Direction = "forward" | "back";

const COARSE_POINTER = "(pointer: coarse)";
const ADVANCE_DELAY_MS = 320;
const AUTOSAVE_DELAY_MS = 1200;

function initialForm(defaults: Application | null, suggestedName: string): FormState {
  const form = emptyForm();
  if (defaults) {
    for (const key of FORM_KEYS) {
      const value = (defaults as Record<string, unknown>)[key];
      form[key] = value === null || value === undefined ? "" : String(value);
    }
    // Drafts saved before the DraftSchema fix stored a BLANK age or hours as 0
    // (app/apply/actions.ts). Age 0 is never an answer and "0 hours a week" is
    // that artifact, not a reply — show them as the blanks they were.
    if (form.age === "0") form.age = "";
    if (form.hours_per_week === "0") form.hours_per_week = "";
  }
  // The name they gave at signup, so the first question is a confirm rather
  // than a retype. Only ever fills a blank — a draft's own answer wins.
  if (!form.full_name && suggestedName) form.full_name = suggestedName;
  return form;
}

/**
 * Focus without scrolling, with the caret after any existing text — a
 * prefilled or returning answer should be ready to add to, not typed in
 * front of. Some input types (email, number) refuse setSelectionRange.
 */
function focusAtEnd(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {}
  }
}

/** Space-joined ids for aria-describedby, or undefined when there are none. */
function ids(...parts: Array<string | null | undefined | false>): string | undefined {
  return parts.filter(Boolean).join(" ") || undefined;
}

function buildFormData(form: FormState, extra: AnswerState, cohortId: string | null) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  // An unticked checkbox is "" and skipped, exactly as a real checkbox posts;
  // readAnswers() on the server turns the absence back into `false`.
  for (const [k, v] of Object.entries(extra)) if (v !== "") fd.append(k, v);
  if (cohortId) fd.append("cohort_id", cohortId);
  return fd;
}

export function ApplyFlow({
  mode,
  email,
  defaults,
  suggestedName,
  questions,
  customQuestions,
  scholarshipQuestions,
  cohorts,
  initialCohortId,
  notices,
  blockedCohortNames,
  parentGuideHref,
  preview = false,
}: {
  mode: Mode;
  email: string;
  /** The draft to continue, or null for a fresh application. */
  defaults: Application | null;
  /** The name from their account, used to prefill a blank full_name. */
  suggestedName: string;
  questions: MergedQuestion[];
  customQuestions: CustomQuestion[];
  scholarshipQuestions: CustomQuestion[];
  /** Cohorts this applicant may apply to, soonest first. Never empty. */
  cohorts: CohortOption[];
  /** Preselected cohort; null = several open and none chosen yet. */
  initialCohortId: string | null;
  /** Server-decided banners for the welcome screen (reapply, founder pass). */
  notices: { tone: "accent" | "neutral"; title: string; body: string }[];
  /** Open cohorts they can't pick because they've had a decision there. */
  blockedCohortNames: string[];
  parentGuideHref: string;
  /** app/dev/apply: the real flow against fixtures, with no server calls. */
  preview?: boolean;
}) {
  const router = useRouter();
  const cfg = useMemo<QuestionMap>(() => buildQuestionMap(questions), [questions]);
  const chooseCohort = cohorts.length > 1;
  const cohortIds = useMemo(() => cohorts.map((c) => c.id), [cohorts]);

  const [form, setForm] = useState<FormState>(() => initialForm(defaults, suggestedName));
  const [extra, setExtra] = useState<AnswerState>(() => ({
    ...seedAnswers(customQuestions, CUSTOM_PREFIX, (defaults as any)?.custom_answers),
    ...seedAnswers(scholarshipQuestions, SCHOLARSHIP_PREFIX, (defaults as any)?.scholarship_answers),
  }));
  const [cohortId, setCohortId] = useState<string | null>(initialCohortId);

  // Always-current copies for the timers and handlers below, which would
  // otherwise close over whatever the state held when they were created. The
  // setters write these synchronously, so "pick an option, then advance" reads
  // the option that was just picked.
  const formRef = useRef(form);
  const extraRef = useRef(extra);
  const cohortRef = useRef(cohortId);
  // Set by every real edit (below), so "Save & exit" writes only when there
  // is something to save — an unedited visit must not insert a blank draft,
  // which for a declined applicant would bury their decision on the dashboard.
  const dirtyRef = useRef(false);

  /** What a save or submit posts: the live answers, cleaned for posting. */
  function payload() {
    return buildFormData(postableForm(formRef.current, cfg), extraRef.current, cohortRef.current);
  }

  const screensFor = useCallback(
    (age: string) =>
      buildScreens({
        cfg,
        customQuestions,
        scholarshipQuestions,
        customPrefix: CUSTOM_PREFIX,
        scholarshipPrefix: SCHOLARSHIP_PREFIX,
        chooseCohort,
        form: { age },
      }),
    [cfg, customQuestions, scholarshipQuestions, chooseCohort],
  );
  const screens = useMemo(() => screensFor(form.age), [screensFor, form.age]);

  const [currentId, setCurrentId] = useState<string>("welcome");
  const currentRef = useRef(currentId);
  const [direction, setDirection] = useState<Direction>("forward");
  // Set when the applicant jumped here from the review screen: Continue then
  // takes them straight back there instead of through every later question.
  const [returnToReview, setReturnToReview] = useState(false);
  const returnRef = useRef(returnToReview);
  const [attempted, setAttempted] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [shake, setShake] = useState(false);
  const [save, setSave] = useState<SaveStatus>({ kind: "idle" });
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [submitPending, startSubmit] = useTransition();
  const [exiting, setExiting] = useState(false);
  const [exitFailed, setExitFailed] = useState(false);

  const found = screens.findIndex((s) => s.id === currentId);
  const index = Math.max(0, found);
  const screen = screens[index];
  // The list can lose the current screen under us (none of today's paths do
  // that, but the list is data-driven). Re-anchor rather than rendering one
  // screen while the handlers act on another.
  useEffect(() => {
    if (found === -1) currentRef.current = screens[0].id;
  }, [found, screens]);
  const questionCount = screens.length - 2; // minus welcome + review
  const selectedCohort = cohorts.find((c) => c.id === cohortId) ?? cohorts[0];
  const name = firstName(form.full_name);

  const ctx: ValidationContext = { form, cfg, extra, cohortId, cohortIds };

  // Whether the draft holds anything the applicant actually wrote, as opposed
  // to what the page prefilled (the signup name) or the server attached (a
  // cohort). Decides "Welcome back" vs a fresh start; frozen at load.
  const [saved] = useState(() => {
    const savedCohort = (defaults as any)?.cohort_id ?? null;
    const savedCtx: ValidationContext = {
      form: initialForm(defaults, ""),
      cfg,
      extra: extraRef.current,
      cohortId: typeof savedCohort === "string" && cohortIds.includes(savedCohort) ? savedCohort : null,
      cohortIds,
    };
    const list = screensFor(savedCtx.form.age).slice(1, -1);
    // A cohort alone isn't progress: the server attaches one to any draft,
    // including the blank row a referral link creates.
    const hasSaved = list.some((s) => s.kind !== "cohort" && screenHasAnswer(s, savedCtx));
    return { hasSaved, savedName: savedCtx.form.full_name };
  });

  /**
   * The live answers, for "you've answered N" and where Continue lands — with
   * one mask: a name the page prefilled and the applicant hasn't touched isn't
   * an answer, so a draft whose saved name is blank still resumes there. Live
   * rather than frozen at load, so edits made since (an age change that drops
   * the parent question) can never point Continue at a screen that's gone.
   */
  function withoutPrefill(live: ValidationContext): ValidationContext {
    const untouchedPrefill = !saved.savedName && live.form.full_name === suggestedName;
    return untouchedPrefill ? { ...live, form: { ...live.form, full_name: "" } } : live;
  }

  function snapshot() {
    const snapForm = formRef.current;
    const snapScreens = screensFor(snapForm.age);
    const snapCtx: ValidationContext = {
      form: snapForm,
      cfg,
      extra: extraRef.current,
      cohortId: cohortRef.current,
      cohortIds,
    };
    const at = Math.max(0, snapScreens.findIndex((s) => s.id === currentRef.current));
    return { screens: snapScreens, ctx: snapCtx, at };
  }

  // ------------------------------------------------------------------ edits

  function clearServerError(names: string[]) {
    setServerErrors((prev) => {
      if (!names.some((n) => prev[n])) return prev;
      const next = { ...prev };
      for (const n of names) delete next[n];
      return next;
    });
  }

  function setField(key: FormKey, value: string) {
    const next = { ...formRef.current, [key]: value };
    formRef.current = next;
    dirtyRef.current = true;
    setForm(next);
    clearServerError([key]);
  }

  function setAnswer(fieldName: string, value: string) {
    const next = { ...extraRef.current, [fieldName]: value };
    extraRef.current = next;
    dirtyRef.current = true;
    setExtra(next);
    clearServerError([fieldName]);
  }

  function pickCohort(id: string) {
    if (cohortRef.current !== id) dirtyRef.current = true;
    cohortRef.current = id;
    setCohortId(id);
    clearServerError(["cohort_id"]);
  }

  // ------------------------------------------------------------- navigation

  const advanceTimer = useRef<number | null>(null);
  function cancelAdvance() {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }

  function goTo(id: string, dir: Direction) {
    cancelAdvance();
    currentRef.current = id;
    setDirection(dir);
    setCurrentId(id);
  }

  function goToIndex(i: number, list: Screen[] = screens) {
    const target = list[Math.max(0, Math.min(i, list.length - 1))];
    const from = list.findIndex((s) => s.id === currentRef.current);
    goTo(target.id, i >= from ? "forward" : "back");
  }

  function refuse(names: string[]) {
    setAttempted((a) => ({ ...a, [currentRef.current]: true }));
    setShake(true);
    window.setTimeout(() => setShake(false), 420);
    focusField(names[0]);
  }

  /** Continue: gate on this screen's answers, then move on. */
  function next() {
    // Enter in a link field leaves before its onBlur fix-up would run.
    if (currentRef.current === "links") {
      for (const key of LINK_KEYS) {
        const fixed = withScheme(formRef.current[key]);
        if (fixed !== formRef.current[key]) setField(key, fixed);
      }
    }
    const { screens: list, ctx: snap, at } = snapshot();
    const here = list[at];
    if (here.kind === "review") return;
    const errs = validateScreen(here, snap);
    if (Object.keys(errs).length > 0) {
      refuse(Object.keys(errs));
      return;
    }
    if (here.kind === "welcome") track("application_started");
    if (returnRef.current) {
      returnRef.current = false;
      setReturnToReview(false);
      goTo("review", "forward");
      return;
    }
    goToIndex(at + 1, list);
  }

  function back() {
    const { screens: list, at } = snapshot();
    if (at === 0) return;
    returnRef.current = false;
    setReturnToReview(false);
    goToIndex(at - 1, list);
  }

  function editFromReview(id: string) {
    returnRef.current = true;
    setReturnToReview(true);
    goTo(id, "back");
  }

  /** Single-choice answers advance on their own, like pressing Continue. */
  function chooseThenAdvance(apply: () => void) {
    apply();
    cancelAdvance();
    const from = currentRef.current;
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      if (currentRef.current === from) next();
    }, ADVANCE_DELAY_MS);
  }

  // ------------------------------------------------------------- focus + a11y

  const stageRef = useRef<HTMLDivElement>(null);

  /** Focus the field that refused — it's on the screen already showing. */
  function focusField(name?: string) {
    const root = stageRef.current;
    if (!root) return;
    const el =
      (name && (root.querySelector(`[data-field="${CSS.escape(name)}"]`) as HTMLElement | null)) ||
      (root.querySelector("[data-autofocus]") as HTMLElement | null) ||
      (root.querySelector("h1") as HTMLElement | null);
    focusAtEnd(el);
  }

  // New screen: back to the top, and put the cursor where the answer goes.
  // useLayoutEffect so the scroll happens before paint rather than after a
  // frame of the old position.
  // Announced when the SCREEN changes, not on every render: the question count
  // moves while someone types their age (17 adds the parent question, 18
  // removes it), and a live region derived from render would read it out.
  const [announcement, setAnnouncement] = useState("");
  const firstRender = useRef(true);
  useLayoutEffect(() => {
    setAnnouncement(
      screen.kind === "review"
        ? "Review your answers"
        : screen.kind === "welcome"
          ? ""
          : `Question ${index} of ${questionCount}`,
    );
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    // Touch keyboards: popping one open on every screen is Typeform's most
    // disliked habit on phones. Only a fine pointer gets the auto-focus onto
    // the input; everyone gets focus moved to the new question itself.
    // Synchronously: the new screen is already in the DOM when a layout
    // effect runs, and a requestAnimationFrame here never fires in a
    // background tab, leaving focus on the body.
    const coarse = window.matchMedia(COARSE_POINTER).matches;
    const root = stageRef.current;
    if (!root) return;
    const input = coarse ? null : (root.querySelector("[data-autofocus]") as HTMLElement | null);
    focusAtEnd(input ?? (root.querySelector("h1") as HTMLElement | null));
  }, [currentId]);

  // ------------------------------------------------------------- keyboard

  // Whether Enter moves on from a long answer here — the same test the key
  // handler below uses. It decides whether "Shift + Enter for a new line" is
  // shown AND announced: on touch, Return is a line break, and a screen reader
  // reading that hint would be describing a keyboard that isn't there. False
  // until mounted, so the server render and hydration agree.
  const [keyboardHints, setKeyboardHints] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(COARSE_POINTER);
    const sync = () => setKeyboardHints(!mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (submitPending || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Enter that confirms an IME composition (Chinese, Japanese, Korean…)
      // belongs to the text, not to "next question". 229 covers Safari, which
      // reports isComposing false on that keydown.
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const here = screens.find((s) => s.id === currentRef.current);
      if (!here) return;

      if (e.key === "Enter") {
        // The flow's own choice controls. An option that's already chosen:
        // Enter means Continue, as the hint says (instead of re-picking it).
        // An unchosen radio: let Enter pick it, as a button would. A checkbox:
        // Continue, so Enter never ticks a consent box by accident — Space and
        // the letter key do that.
        if (target?.hasAttribute("data-choice-key")) {
          if (here.kind === "review") return;
          e.preventDefault();
          const role = target.getAttribute("role");
          // Explicit rather than left to the browser's own Enter activation,
          // which fires on keydown in some engines and keypress in others.
          if (role === "radio" && target.getAttribute("aria-checked") !== "true") target.click();
          else next();
          return;
        }
        if (tag === "BUTTON" || tag === "A") return; // let it activate
        if (tag === "TEXTAREA") {
          // Shift+Enter is a line break. On touch there is no easy Shift, so
          // Return stays a line break there and the button does the moving on.
          if (e.shiftKey || window.matchMedia(COARSE_POINTER).matches) return;
        }
        if (here.kind === "review") return;
        e.preventDefault();
        if (here.kind === "welcome") {
          stageRef.current?.querySelector<HTMLButtonElement>("[data-primary]")?.click();
          return;
        }
        // Multi-input screens: Enter walks the inputs before leaving.
        if (tag === "INPUT" && target) {
          const inputs = Array.from(
            stageRef.current?.querySelectorAll<HTMLInputElement>("input[data-field]") ?? [],
          );
          const at = inputs.indexOf(target as HTMLInputElement);
          if (at > -1 && at < inputs.length - 1) {
            inputs[at + 1].focus();
            return;
          }
        }
        next();
        return;
      }

      if (typing) return;
      // Letter shortcuts on choice screens: A, B, C…
      if (/^[a-z]$/i.test(e.key)) {
        const option = stageRef.current?.querySelector<HTMLButtonElement>(
          `[data-choice-key="${e.key.toUpperCase()}"]`,
        );
        if (option) {
          e.preventDefault();
          option.click();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // `next` reads refs, so a stale closure of it is still correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens, submitPending]);

  // ------------------------------------------------------------- referral

  // A referral code stashed at signup (or ?ref= here) is attached through its
  // own action: a draft save carrying only referral_code would blank the rest.
  useEffect(() => {
    if (preview) return;
    let code = readRefFromLocation();
    if (!code) {
      try {
        code = window.localStorage.getItem(REF_STORAGE_KEY) ?? "";
      } catch {}
    }
    if (code) {
      attachReferralCodeAction(code).catch(() => {});
      try {
        window.localStorage.removeItem(REF_STORAGE_KEY);
      } catch {}
    }
  }, []);

  // ------------------------------------------------------------- autosave

  const submittingRef = useRef(false);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const skipFirstSave = useRef(true);

  /** Save now if anything changed. Resolves true when nothing is left unsaved. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (submittingRef.current) return true;
    // A save already running may be carrying the latest edit; let it land
    // before deciding whether there's anything left to write.
    if (inFlightRef.current) await inFlightRef.current;
    if (!dirtyRef.current) return true;
    dirtyRef.current = false;
    setSave({ kind: "saving" });
    if (preview) {
      await new Promise((r) => window.setTimeout(r, 300));
      setSave({ kind: "saved" });
      return true;
    }
    const run = saveDraftAction(null, payload())
      .then((result) => {
        if (result.ok) {
          setSave({ kind: "saved" });
          setExitFailed(false);
          return true;
        }
        // Keep it dirty so the next tick retries instead of dropping it.
        dirtyRef.current = true;
        setSave({ kind: "error", message: "Couldn't save — retrying" });
        return false;
      })
      .catch(() => {
        dirtyRef.current = true;
        setSave({ kind: "error", message: "Offline — will retry" });
        return false;
      });
    inFlightRef.current = run;
    const ok = await run;
    if (inFlightRef.current === run) inFlightRef.current = null;
    return ok;
  }, [preview]);

  useEffect(() => {
    // Loading the page must not re-save the draft it just loaded.
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return;
    }
    dirtyRef.current = true;
    const timer = window.setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [form, extra, cohortId, saveNow]);

  // A closed tab or a backgrounded phone keeps the latest keystrokes.
  useEffect(() => {
    const flush = () => {
      if (preview || !dirtyRef.current || submittingRef.current) return;
      dirtyRef.current = false;
      // Tracked like any save, and re-marked unsaved if it fails — a flush
      // that dies while the phone is backgrounded must not leave Save & exit
      // believing there's nothing to write.
      const run = saveDraftAction(null, payload()).then(
        (r) => {
          if (!r.ok) dirtyRef.current = true;
          return r.ok;
        },
        () => {
          dirtyRef.current = true;
          return false;
        },
      );
      inFlightRef.current = run;
      void run.then(() => {
        if (inFlightRef.current === run) inFlightRef.current = null;
      });
    };
    const onVis = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [preview]);

  async function saveAndExit() {
    // Second press after a failed save: they've seen the error; let them go.
    if (exitFailed) {
      if (!preview) router.push("/dashboard");
      return;
    }
    setExiting(true);
    // Writes only if something was edited since the last save — including a
    // keystroke the debounced autosave hasn't flushed yet (the setters mark
    // dirty synchronously).
    const ok = await saveNow();
    setExiting(false);
    if (!ok) {
      // Don't navigate away from answers that didn't make it. The header
      // shows the error; the button now offers to leave anyway.
      setExitFailed(true);
      return;
    }
    if (!preview) router.push("/dashboard");
  }

  // ------------------------------------------------------------- submit

  function submit() {
    const { screens: list, ctx: snap } = snapshot();
    const { errors, firstInvalid } = validateAll(list, snap);
    if (firstInvalid !== -1) {
      const marked: Record<string, boolean> = {};
      for (const s of list) {
        if (screenFieldNames(s).some((n) => errors[n])) marked[s.id] = true;
      }
      setAttempted((a) => ({ ...a, ...marked }));
      returnRef.current = true;
      setReturnToReview(true);
      goTo(list[firstInvalid].id, "back");
      return;
    }
    setSubmitError(undefined);
    if (preview) {
      setSubmitError("Preview only — nothing was submitted. On /apply this is where it goes to review.");
      return;
    }
    submittingRef.current = true;
    startSubmit(async () => {
      // A draft save landing after the submit would write status "draft" back
      // over "submitted". Wait out anything already in flight first.
      if (inFlightRef.current) await inFlightRef.current.catch(() => {});
      const result = await submitApplicationAction(null, payload());
      // Success redirects server-side; reaching here means it didn't go through.
      submittingRef.current = false;
      if (!result.ok) {
        setSubmitError(result.error ?? "Something went wrong. Try again.");
        const fieldErrors = result.fieldErrors ?? {};
        if (Object.keys(fieldErrors).length > 0) {
          setServerErrors(fieldErrors);
          const owner = list.find((s) => screenFieldNames(s).some((n) => fieldErrors[n]));
          if (owner) editFromReview(owner.id);
        }
      }
    });
  }

  // ------------------------------------------------------------- render

  const liveErrors = attempted[screen.id] ? validateScreen(screen, ctx) : {};
  const errorFor = (fieldName: string) => serverErrors[fieldName] || liveErrors[fieldName] || "";
  const screenError = screenFieldNames(screen).map(errorFor).find(Boolean) ?? "";

  const progress =
    screen.kind === "welcome" ? 0 : screen.kind === "review" ? 100 : (index / (screens.length - 1)) * 100;

  const optional = (key: FormKey) => !isRequired(cfg, key);

  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-[100dvh] flex-col bg-paper outline-none">
      <FlowHeader
        progress={progress}
        counter={
          screen.kind === "welcome" || screen.kind === "review"
            ? null
            : `${index} of ${questionCount}`
        }
        save={save}
        exiting={exiting}
        exitLabel={exitFailed ? "Leave without saving" : "Save & exit"}
        onExit={saveAndExit}
      />

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="flex flex-1 items-start sm:items-center">
        <div
          ref={stageRef}
          key={screen.id}
          className={`mx-auto w-full max-w-2xl px-5 pb-32 pt-10 sm:px-8 sm:pb-28 sm:pt-12 ${
            direction === "forward" ? "tf-in-forward" : "tf-in-back"
          }`}
        >
          {screen.kind === "welcome" && (
            <WelcomeScreen
              mode={mode}
              email={email}
              name={name}
              cohorts={cohorts}
              selected={selectedCohort}
              questionCount={questionCount}
              answeredCount={saved.hasSaved ? screens.slice(1, -1).filter((s) => screenHasAnswer(s, withoutPrefill(ctx))).length : 0}
              notices={notices}
              parentGuideHref={parentGuideHref}
              resumeLabel={mode === "draft" && saved.hasSaved ? "Continue where you left off" : null}
              onStart={next}
              onResume={() => {
                track("application_started");
                const { screens: list, ctx: live } = snapshot();
                goToIndex(resumeIndex(list, withoutPrefill(live)), list);
              }}
            />
          )}

          {screen.kind === "cohort" && (
            <Question
              number={index}
              section={SECTION_LABELS.cohort}
              prompt="Which cohort do you want to join?"
              help="Each cohort is the same program on different dates. You can switch until you submit."
              error={screenError}
              shake={shake}
              onContinue={next}
              returnToReview={returnToReview}
            >
              <div role="radiogroup" aria-label="Cohort" className="space-y-3">
                {cohorts.map((c, i) => {
                  const selected = c.id === cohortId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-choice-key={choiceKey(i)}
                      // No auto-advance here, unlike the other choices: a
                      // card carries dates, price and (for late entry) a
                      // catch-up plan that appears on selection — worth a
                      // read before moving on.
                      onClick={() => pickCohort(c.id)}
                      className={`flex w-full items-start gap-4 rounded-md border px-4 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${
                        selected
                          ? "border-phosphor bg-phosphor/10"
                          : "border-line bg-paper hover:border-ink/40 hover:bg-wash"
                      }`}
                    >
                      <KeyBadge letter={choiceKey(i)} selected={selected} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <span className="font-display text-[1.75rem] leading-none text-ink">{c.name}</span>
                          {i === 0 && !c.lateEntry && (
                            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-phosphor-ink">
                              Starts soonest
                            </span>
                          )}
                          {c.lateEntry && (
                            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-phosphor-ink">
                              Late entry
                            </span>
                          )}
                        </span>
                        <span className="mt-2 block text-sm text-ink-soft">
                          {c.dates}
                          {c.weeks ? ` · ${c.weeks} weeks` : ""} · live, online
                        </span>
                        <span className="mt-1 block text-sm text-ink-soft">
                          {c.priceLabel} tuition · charged only if you&apos;re accepted
                        </span>
                        {c.deadlineLabel && (
                          <span className="mt-1 block text-xs text-ink-faint">{c.deadlineLabel}</span>
                        )}
                        {selected && c.lateEntry && c.catchUpPlan && (
                          <span className="mt-3 block border-l-2 border-phosphor pl-3 text-xs leading-relaxed text-ink-soft">
                            {c.catchUpPlan}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              {blockedCohortNames.length > 0 && (
                <p className="mt-4 text-xs text-ink-faint">
                  {blockedCohortNames.join(" and ")} isn&apos;t listed — you&apos;ve already had a decision there.
                </p>
              )}
            </Question>
          )}

          {screen.kind === "field" && (
            <FieldScreen
              keyboardHints={keyboardHints}
              fieldKey={screen.key}
              number={index}
              section={SECTION_LABELS[screen.section]}
              cfg={cfg}
              form={form}
              name={name}
              error={screenError}
              shake={shake}
              optional={screen.key === "parent_email" ? !isMinor(form.age) && optional("parent_email") : optional(screen.key)}
              returnToReview={returnToReview}
              onChange={setField}
              onContinue={next}
              onChoose={(v) => chooseThenAdvance(() => setField(screen.key, v))}
            />
          )}

          {screen.kind === "location" && (
            <Question
              number={index}
              section={SECTION_LABELS[screen.section]}
              prompt="Where are you based?"
              help="City and country are enough — no address."
              optional={LOCATION_KEYS.every((k) => !isVisible(cfg, k) || optional(k))}
              error=""
              shake={shake}
              onContinue={next}
              returnToReview={returnToReview}
            >
              <div className="grid gap-6 sm:grid-cols-2">
                {LOCATION_KEYS.filter((k) => isVisible(cfg, k)).map((key, i) => (
                  <LabeledInput
                    key={key}
                    fieldKey={key}
                    label={cfg[key].label}
                    required={isRequired(cfg, key)}
                    value={form[key]}
                    error={errorFor(key)}
                    placeholder={cfg[key].placeholder || (key === "city" ? "Austin" : "United States")}
                    autoComplete={key === "city" ? "address-level2" : "country-name"}
                    autoFocus={i === 0}
                    onChange={(v) => setField(key, v)}
                  />
                ))}
              </div>
            </Question>
          )}

          {screen.kind === "links" && (
            <Question
              number={index}
              section={SECTION_LABELS[screen.section]}
              prompt="Anything you'd like to show us?"
              help="Share work you already have. You don't need a résumé or a LinkedIn to apply."
              optional={LINK_KEYS.every((k) => !isVisible(cfg, k) || optional(k))}
              error=""
              shake={shake}
              onContinue={next}
              returnToReview={returnToReview}
            >
              <div className="space-y-6">
                {LINK_KEYS.filter((k) => isVisible(cfg, k)).map((key, i) => (
                  <LabeledInput
                    key={key}
                    fieldKey={key}
                    label={cfg[key].label}
                    required={isRequired(cfg, key)}
                    value={form[key]}
                    error={errorFor(key)}
                    placeholder={cfg[key].placeholder || "https://"}
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    autoFocus={i === 0}
                    onChange={(v) => setField(key, v)}
                    onBlur={() => {
                      const fixed = withScheme(formRef.current[key]);
                      if (fixed !== formRef.current[key]) setField(key, fixed);
                    }}
                  />
                ))}
              </div>
            </Question>
          )}

          {screen.kind === "custom" && (
            <CustomScreen
              keyboardHints={keyboardHints}
              screen={screen}
              number={index}
              value={extra[screen.id] ?? ""}
              error={screenError}
              shake={shake}
              returnToReview={returnToReview}
              onChange={(v) => setAnswer(screen.id, v)}
              onChoose={(v) => chooseThenAdvance(() => setAnswer(screen.id, v))}
              onContinue={next}
            />
          )}

          {screen.kind === "review" && (
            <ReviewScreen
              screens={screens}
              cfg={cfg}
              form={form}
              extra={extra}
              ctx={ctx}
              name={name}
              cohort={selectedCohort}
              canChangeCohort={chooseCohort}
              submitError={submitError}
              pending={submitPending}
              onEdit={editFromReview}
              onSubmit={submit}
            />
          )}
        </div>
      </div>

      <StepNav
        canBack={index > 0}
        canForward={screen.kind !== "review" && screen.kind !== "welcome"}
        onBack={back}
        onForward={next}
        hidden={screen.kind === "welcome"}
      />
    </main>
  );
}

// ===========================================================================
// Chrome
// ===========================================================================

function FlowHeader({
  progress,
  counter,
  save,
  exiting,
  exitLabel,
  onExit,
}: {
  progress: number;
  counter: string | null;
  save: SaveStatus;
  exiting: boolean;
  exitLabel: string;
  onExit: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper">
      <div
        className="h-[3px] w-full bg-line"
        role="progressbar"
        aria-label="Application progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div className="tf-progress h-full bg-phosphor" style={{ width: `${progress}%` }} />
      </div>
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
        <Wordmark className="h-4 text-ink" />
        <div className="flex items-center gap-4 sm:gap-6">
          {counter && (
            <span className="hidden font-mono text-xs text-ink-faint sm:inline">{counter}</span>
          )}
          <SaveIndicator status={save} />
          <button
            type="button"
            onClick={onExit}
            disabled={exiting}
            className="press rounded-md px-2 py-1 text-sm text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor disabled:opacity-60"
          >
            {exiting ? "Saving…" : exitLabel}
          </button>
        </div>
      </div>
    </header>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const body =
    status.kind === "saving" ? (
      <>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving
      </>
    ) : status.kind === "saved" ? (
      <>
        <Check className="h-3 w-3" aria-hidden /> Saved
      </>
    ) : status.kind === "error" ? (
      <span className="inline-flex items-center gap-1.5 text-[#B42318] dark:text-red-300">
        <AlertCircle className="h-3 w-3" aria-hidden /> {status.message}
      </span>
    ) : null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-ink-faint"
    >
      {body}
    </span>
  );
}

function StepNav({
  canBack,
  canForward,
  onBack,
  onForward,
  hidden,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  hidden: boolean;
}) {
  if (hidden) return null;
  const cls =
    "flex h-10 w-10 items-center justify-center text-ink hover:bg-wash disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-phosphor";
  return (
    <nav
      aria-label="Question navigation"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-20 pb-safe"
    >
      <div className="mx-auto flex max-w-5xl justify-end px-5 pb-4 sm:px-8 sm:pb-6">
        <div className="pointer-events-auto flex overflow-hidden rounded-md border border-line bg-paper">
          <button type="button" onClick={onBack} disabled={!canBack} aria-label="Previous question" className={cls}>
            <ChevronUp className="h-5 w-5" aria-hidden />
          </button>
          <span aria-hidden className="w-px bg-line" />
          <button type="button" onClick={onForward} disabled={!canForward} aria-label="Next question" className={cls}>
            <ChevronDown className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
    </nav>
  );
}

// ===========================================================================
// Building blocks
// ===========================================================================

function Question({
  number,
  section,
  prompt,
  help,
  required,
  optional,
  error,
  shake,
  returnToReview,
  onContinue,
  continueLabel,
  children,
  below,
}: {
  number: number;
  section: string;
  prompt: string;
  help?: string;
  required?: boolean;
  optional?: boolean;
  error: string;
  shake: boolean;
  returnToReview: boolean;
  onContinue: () => void;
  continueLabel?: string;
  children: ReactNode;
  below?: ReactNode;
}) {
  const headingId = `q-${number}-heading`;
  return (
    <section aria-labelledby={headingId}>
      <p className="flex items-center gap-2 font-mono text-xs text-ink-faint">
        <span className="inline-flex items-center gap-1 text-phosphor-ink">
          {number}
          <ArrowRight className="h-3 w-3" aria-hidden />
        </span>
        <span className="uppercase tracking-[0.14em]">{section}</span>
      </p>
      <h1
        id={headingId}
        tabIndex={-1}
        className="mt-3 font-display text-[clamp(2rem,5.2vw,2.75rem)] leading-[1.08] text-ink outline-none"
      >
        {prompt}
        {required && (
          <>
            <span aria-hidden className="text-phosphor-ink"> *</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </h1>
      {optional && (
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">Optional</p>
      )}
      {help && (
        <p id={`q-${number}-help`} className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          {help}
        </p>
      )}
      <div className="mt-8">{children}</div>
      {error && <ErrorNote id={`q-${number}-error`}>{error}</ErrorNote>}
      {below}
      <ContinueRow
        label={continueLabel ?? (returnToReview ? "Back to review" : "OK")}
        shake={shake}
        onClick={onContinue}
      />
    </section>
  );
}

function ContinueRow({
  label,
  shake,
  onClick,
  hint = "Enter",
}: {
  label: string;
  shake: boolean;
  onClick: () => void;
  hint?: string;
}) {
  return (
    <div className="mt-8 flex items-center gap-4">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex h-12 items-center gap-2 rounded-md bg-phosphor px-6 text-base font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
          shake ? "animate-shake" : ""
        }`}
      >
        {label}
        <Check className="h-4 w-4" aria-hidden />
      </button>
      <span className="tf-hint items-center gap-1.5 font-mono text-xs text-ink-faint">
        press <kbd className="inline-flex items-center gap-1 font-semibold text-ink-soft">{hint} <CornerDownLeft className="h-3 w-3" aria-hidden /></kbd>
      </span>
    </div>
  );
}

function ErrorNote({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-4 inline-flex items-start gap-2 rounded-md bg-[#B42318]/[0.08] px-3 py-2 text-sm text-[#B42318] dark:bg-red-400/10 dark:text-red-300"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function KeyBadge({ letter, selected }: { letter: string; selected: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border font-mono text-xs font-semibold ${
        selected ? "border-phosphor bg-phosphor text-on-phosphor" : "border-line bg-paper text-ink-soft"
      }`}
    >
      {letter}
    </span>
  );
}

function ChoiceList({
  labelledBy,
  describedBy,
  invalid,
  options,
  value,
  onChoose,
}: {
  /** The question heading's id — the group's name. */
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  options: { value: string; label: string }[];
  value: string;
  onChoose: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className="flex max-w-md flex-col gap-2.5"
    >
      {options.map((o, i) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-choice-key={choiceKey(i)}
            onClick={() => onChoose(o.value)}
            className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${
              selected
                ? "border-phosphor bg-phosphor/10 text-ink"
                : "border-line bg-paper text-ink hover:border-ink/40 hover:bg-wash"
            }`}
          >
            <KeyBadge letter={choiceKey(i)} selected={selected} />
            <span className="flex-1">{o.label}</span>
            {selected && <Check className="h-4 w-4 text-phosphor-ink" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

function QuickPicks({
  options,
  value,
  onPick,
}: {
  options: readonly string[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {options.map((o) => {
        const selected = value.trim().toLowerCase() === o.toLowerCase();
        return (
          <button
            key={o}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(o)}
            className={`rounded-md border px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${
              selected
                ? "border-phosphor bg-phosphor/10 text-ink"
                : "border-line text-ink-soft hover:border-ink/40 hover:text-ink"
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Auto-growing textarea, so a long answer never scrolls inside a box. */
function GrowingTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string },
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.max(el.scrollHeight, 96)}px`;
    };
    fit();
    // Re-fit when the width changes too (a phone rotating, a window
    // narrowing): the text rewraps taller and overflow:hidden would clip it.
    // Width only, so the height this writes can't retrigger the observer.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea ref={ref} rows={3} {...props} />;
}

function LabeledInput({
  fieldKey,
  label,
  required,
  value,
  error,
  placeholder,
  type = "text",
  inputMode,
  autoComplete,
  autoFocus,
  onChange,
  onBlur,
}: {
  fieldKey: FormKey;
  label: string;
  required: boolean;
  value: string;
  error: string;
  placeholder?: string;
  type?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  autoComplete?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  return (
    <div>
      <label htmlFor={fieldKey} className="block font-mono text-xs uppercase tracking-[0.12em] text-ink-soft">
        {label}
        {required ? (
          <>
            <span aria-hidden className="text-phosphor-ink"> *</span>
            <span className="sr-only"> (required)</span>
          </>
        ) : (
          <span className="ml-2 normal-case tracking-normal text-ink-faint">optional</span>
        )}
      </label>
      <input
        id={fieldKey}
        name={fieldKey}
        data-field={fieldKey}
        data-autofocus={autoFocus ? true : undefined}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={MAX_LENGTH[fieldKey]}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldKey}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="tf-field mt-2"
      />
      {error && (
        <p id={`${fieldKey}-error`} role="alert" className="mt-2 text-sm text-[#B42318] dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

// ===========================================================================
// Screens
// ===========================================================================

function WelcomeScreen({
  mode,
  email,
  name,
  cohorts,
  selected,
  questionCount,
  answeredCount,
  notices,
  parentGuideHref,
  resumeLabel,
  onStart,
  onResume,
}: {
  mode: Mode;
  email: string;
  name: string;
  cohorts: CohortOption[];
  selected: CohortOption;
  questionCount: number;
  answeredCount: number;
  notices: { tone: "accent" | "neutral"; title: string; body: string }[];
  parentGuideHref: string;
  resumeLabel: string | null;
  onStart: () => void;
  onResume: () => void;
}) {
  const single = cohorts.length === 1;
  const minutes = questionCount > 10 ? "about 10 minutes" : "about 5 minutes";
  return (
    <section aria-labelledby="welcome-heading">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-phosphor-ink">
        {mode === "reapply" ? "Apply again" : resumeLabel ? "Welcome back" : "Application"}
      </p>
      <h1
        id="welcome-heading"
        tabIndex={-1}
        className="mt-4 font-display text-[clamp(2.75rem,8vw,4.25rem)] leading-[1.02] text-ink outline-none"
      >
        {resumeLabel && name
          ? `Pick up where you left off, ${name}.`
          : single
            ? <>Apply to <span className="hl">{selected.name}</span>.</>
            : "Apply to batch0."}
      </h1>
      <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-soft">
        {resumeLabel
          ? `You've answered ${answeredCount} of ${questionCount} questions. Everything you wrote is saved — pick up at the next one, or start from the top to look it all over.`
          : `${questionCount} short questions, one at a time — ${minutes}. Your answers save as you go, so you can stop anytime and come back.`}
      </p>

      <div className="ledger mt-8 max-w-md text-ink">
        {single ? (
          <>
            <LedgerRow label="Cohort" value={selected.name} />
            <LedgerRow label="Dates" value={selected.dates} />
          </>
        ) : (
          <LedgerRow label="Cohorts" value={`${cohorts.length} open — you'll pick one`} />
        )}
        <LedgerRow label="Format" value="live, online" />
        <LedgerRow
          label="Tuition"
          value={single ? `${selected.priceLabel} · only if accepted` : "charged only if accepted"}
        />
        <LedgerRow label="Applying" value="free" />
        <LedgerRow label="Decisions" value="rolling, by email" />
      </div>

      {single && selected.lateEntry && (
        <div className="mt-6 max-w-xl border-l-2 border-phosphor bg-wash p-4 text-sm leading-relaxed">
          <p className="font-semibold text-ink">
            {selected.name} has already started.{selected.deadlineLabel ? ` ${selected.deadlineLabel}.` : ""}
          </p>
          {selected.catchUpPlan && <p className="mt-2 text-ink-soft">{selected.catchUpPlan}</p>}
        </div>
      )}

      {notices.map((n) => (
        <div
          key={n.title}
          className={`mt-6 max-w-xl border-l-2 p-4 text-sm leading-relaxed ${
            n.tone === "accent" ? "border-phosphor bg-wash" : "border-line bg-wash"
          }`}
        >
          <p className="font-semibold text-ink">{n.title}</p>
          <p className="mt-1 text-ink-soft">{n.body}</p>
        </div>
      ))}

      <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="button"
          data-autofocus
          data-primary
          onClick={resumeLabel ? onResume : onStart}
          className="inline-flex h-12 items-center gap-2 rounded-md bg-phosphor px-6 text-base font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          {resumeLabel ?? (mode === "reapply" ? "Start a new application" : "Start application")}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
        {resumeLabel ? (
          <button
            type="button"
            onClick={onStart}
            className="text-sm text-ink-soft underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-phosphor"
          >
            Start from the first question
          </button>
        ) : (
          <span className="tf-hint items-center gap-1.5 font-mono text-xs text-ink-faint">
            press <kbd className="inline-flex items-center gap-1 font-semibold text-ink-soft">Enter <CornerDownLeft className="h-3 w-3" aria-hidden /></kbd>
          </span>
        )}
      </div>

      <p className="mt-10 text-xs leading-relaxed text-ink-faint">
        Signed in as <span className="text-ink-soft [overflow-wrap:anywhere]">{email}</span> ·{" "}
        <a href={parentGuideHref} className="link-ink">
          Schedule &amp; parent guide
        </a>
      </p>
    </section>
  );
}

function LedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ledger-row">
      <span className="uppercase text-ink-soft">{label}</span>
      <span aria-hidden className="ledger-dots" />
      <span className="text-right">{value}</span>
    </div>
  );
}

function FieldScreen({
  keyboardHints,
  fieldKey,
  number,
  section,
  cfg,
  form,
  name,
  error,
  shake,
  optional,
  returnToReview,
  onChange,
  onContinue,
  onChoose,
}: {
  keyboardHints: boolean;
  fieldKey: FormKey;
  number: number;
  section: string;
  cfg: QuestionMap;
  form: FormState;
  name: string;
  error: string;
  shake: boolean;
  optional: boolean;
  returnToReview: boolean;
  onChange: (key: FormKey, value: string) => void;
  onContinue: () => void;
  onChoose: (value: string) => void;
}) {
  const q = cfg[fieldKey];
  const value = form[fieldKey];
  const errorId = error ? `q-${number}-error` : undefined;
  const prompt = promptFor(fieldKey, cfg, name);
  // Parent email's own help is written for everyone ("for applicants under
  // 18…"); by the time it's asked here, it IS being asked because they're 18.
  const help =
    fieldKey === "parent_email" && isMinor(form.age)
      ? "You're under 18, so we'll send them a short note about the program once you submit."
      : q.help;
  const continueLabel = optional && !value.trim() ? (returnToReview ? "Back to review" : "Skip") : undefined;
  // Everything said about the answer besides its question: the help line,
  // the new-line hint and the essay's length counter, then any error.
  const describedBy = ids(
    help && `q-${number}-help`,
    keyboardHints && q.type === "textarea" && `q-${number}-hint`,
    fieldKey === "why_join" && `q-${number}-counter`,
    errorId,
  );

  const common = {
    id: fieldKey,
    name: fieldKey,
    "data-field": fieldKey,
    "data-autofocus": true,
    value,
    maxLength: MAX_LENGTH[fieldKey],
    // The stock parent-email placeholder reads "Optional — only needed if
    // you're under 18", which is exactly who this screen is asked of.
    placeholder:
      fieldKey === "parent_email" && isMinor(form.age)
        ? "parent@example.com"
        : q.placeholder || undefined,
    "aria-labelledby": `q-${number}-heading`,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": !optional || undefined,
  } as const;

  let input: ReactNode;
  let below: ReactNode = null;

  if (fieldKey === "team_size") {
    input = (
      <ChoiceList
        labelledBy={`q-${number}-heading`}
        describedBy={describedBy}
        invalid={!!error}
        value={value}
        options={(q.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))}
        onChoose={onChoose}
      />
    );
  } else if (q.type === "textarea") {
    const whyLen = value.trim().length;
    input = (
      <>
        <GrowingTextarea
          {...common}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          className="tf-field tf-area"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-ink-faint">
          {keyboardHints ? <span id={`q-${number}-hint`}>Shift + Enter for a new line</span> : <span />}
          {fieldKey === "why_join" ? (
            whyLen >= WHY_MIN ? (
              <span id={`q-${number}-counter`} className="inline-flex items-center gap-1 text-phosphor-ink">
                <Check className="h-3 w-3" aria-hidden /> Good length
              </span>
            ) : (
              <span id={`q-${number}-counter`}>
                {whyLen}/{WHY_MIN} characters minimum
              </span>
            )
          ) : (
            value.length > MAX_LENGTH[fieldKey] * 0.8 && (
              <span>
                {value.length}/{MAX_LENGTH[fieldKey]}
              </span>
            )
          )}
        </div>
      </>
    );
    if (fieldKey === "startup_idea") below = <IdeaValidator idea={value} />;
  } else {
    const typeProps =
      fieldKey === "age" || fieldKey === "hours_per_week"
        ? { type: "text", inputMode: "numeric" as const, pattern: "[0-9]*" }
        : fieldKey === "phone"
          ? { type: "tel", inputMode: "tel" as const, autoComplete: "tel" }
          : fieldKey === "parent_email"
            ? { type: "email", inputMode: "email" as const, autoComplete: "off", autoCapitalize: "off", spellCheck: false }
            : fieldKey === "full_name"
              ? { type: "text", autoComplete: "name" }
              : fieldKey === "school"
                ? { type: "text", autoComplete: "organization" }
                : { type: "text" };
    input = (
      <>
        <input
          {...common}
          {...typeProps}
          onChange={(e) => {
            const v =
              fieldKey === "age" || fieldKey === "hours_per_week"
                ? e.target.value.replace(/[^\d]/g, "")
                : e.target.value;
            onChange(fieldKey, v);
          }}
          className={`tf-field ${fieldKey === "age" || fieldKey === "hours_per_week" ? "max-w-[8rem]" : ""}`}
        />
        {QUICK_PICKS[fieldKey] && (
          <QuickPicks
            options={QUICK_PICKS[fieldKey]!}
            value={value}
            onPick={(v) => {
              onChange(fieldKey, v);
              // Back to the answer line, so Enter means "OK" rather than
              // clicking the chip a second time.
              focusAtEnd(document.getElementById(fieldKey));
            }}
          />
        )}
      </>
    );
  }

  return (
    <Question
      number={number}
      section={section}
      prompt={prompt}
      help={help}
      required={!optional}
      optional={optional}
      error={error}
      shake={shake}
      returnToReview={returnToReview}
      onContinue={onContinue}
      continueLabel={continueLabel}
      below={below}
    >
      {input}
    </Question>
  );
}

function CustomScreen({
  keyboardHints,
  screen,
  number,
  value,
  error,
  shake,
  returnToReview,
  onChange,
  onChoose,
  onContinue,
}: {
  keyboardHints: boolean;
  screen: Extract<Screen, { kind: "custom" }>;
  number: number;
  value: string;
  error: string;
  shake: boolean;
  returnToReview: boolean;
  onChange: (value: string) => void;
  onChoose: (value: string) => void;
  onContinue: () => void;
}) {
  const q = screen.question;
  const errorId = error ? `q-${number}-error` : undefined;
  const optional = !q.required;
  const describedBy = ids(
    q.help && `q-${number}-help`,
    keyboardHints && q.type === "textarea" && `q-${number}-hint`,
    errorId,
  );

  let input: ReactNode;
  if (q.type === "checkbox") {
    const checked = value === "on";
    input = (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        // Named by the question and its "Yes", so a rotor lists it as the
        // question rather than a bare "Yes, checkbox".
        aria-labelledby={`q-${number}-heading q-${number}-yes`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={q.required || undefined}
        data-choice-key="A"
        data-field={screen.id}
        onClick={() => onChange(checked ? "" : "on")}
        className={`flex max-w-md items-center gap-3 rounded-md border px-3 py-3 text-left text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor ${
          checked ? "border-phosphor bg-phosphor/10" : "border-line hover:border-ink/40 hover:bg-wash"
        }`}
      >
        <KeyBadge letter="A" selected={checked} />
        <span id={`q-${number}-yes`} className="flex-1 text-ink">Yes</span>
        {checked && <Check className="h-4 w-4 text-phosphor-ink" aria-hidden />}
      </button>
    );
  } else if (hasOptions(q.type)) {
    input = (
      <ChoiceList
        labelledBy={`q-${number}-heading`}
        describedBy={describedBy}
        invalid={!!error}
        value={value}
        options={q.options}
        onChoose={onChoose}
      />
    );
  } else if (q.type === "textarea") {
    input = (
      <>
        <GrowingTextarea
          id={screen.id}
          name={screen.id}
          data-field={screen.id}
          data-autofocus
          value={value}
          placeholder={q.placeholder || undefined}
          aria-labelledby={`q-${number}-heading`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className="tf-field tf-area"
        />
        {keyboardHints && (
          <p id={`q-${number}-hint`} className="mt-2 font-mono text-xs text-ink-faint">
            Shift + Enter for a new line
          </p>
        )}
      </>
    );
  } else {
    input = (
      <input
        id={screen.id}
        name={screen.id}
        data-field={screen.id}
        data-autofocus
        type={q.type === "number" ? "text" : q.type === "email" ? "email" : q.type === "date" ? "date" : q.type === "url" ? "url" : "text"}
        inputMode={q.type === "number" ? "decimal" : q.type === "email" ? "email" : q.type === "url" ? "url" : undefined}
        value={value}
        placeholder={q.placeholder || undefined}
        aria-labelledby={`q-${number}-heading`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className={`tf-field ${q.type === "number" || q.type === "date" ? "max-w-xs" : ""}`}
      />
    );
  }

  return (
    <Question
      number={number}
      section={SECTION_LABELS[screen.section]}
      prompt={q.label}
      help={q.help || undefined}
      required={!optional}
      optional={optional}
      error={error}
      shake={shake}
      returnToReview={returnToReview}
      onContinue={onContinue}
      continueLabel={optional && !value ? (returnToReview ? "Back to review" : "Skip") : undefined}
    >
      {screen.intro && (
        <p className="-mt-3 mb-8 max-w-xl border-l-2 border-phosphor bg-wash p-4 text-sm leading-relaxed text-ink-soft">
          batch0 offers scholarships, and answering here doesn&apos;t commit you to anything. If you&apos;re
          accepted, you&apos;ll be able to apply for them properly from your dashboard.
        </p>
      )}
      {input}
    </Question>
  );
}

function ReviewScreen({
  screens,
  cfg,
  form,
  extra,
  ctx,
  name,
  cohort,
  canChangeCohort,
  submitError,
  pending,
  onEdit,
  onSubmit,
}: {
  screens: Screen[];
  cfg: QuestionMap;
  form: FormState;
  extra: AnswerState;
  ctx: ValidationContext;
  name: string;
  cohort: CohortOption;
  canChangeCohort: boolean;
  submitError?: string;
  pending: boolean;
  onEdit: (id: string) => void;
  onSubmit: () => void;
}) {
  const rows = screens.filter((s) => s.kind !== "welcome" && s.kind !== "review" && s.kind !== "cohort");
  const { errors } = validateAll(screens, ctx);
  const needs = rows.filter((s) => screenFieldNames(s).some((n) => errors[n]));

  function valueOf(s: Screen): string {
    switch (s.kind) {
      case "field":
        if (s.key === "team_size") {
          return cfg.team_size.options?.find((o) => String(o.value) === form.team_size)?.label ?? "";
        }
        return form[s.key];
      case "location":
        return LOCATION_KEYS.map((k) => form[k].trim()).filter(Boolean).join(", ");
      case "links":
        return LINK_KEYS.map((k) => form[k].trim()).filter(Boolean).join("\n");
      case "custom":
        return formatAnswer(s.question, readAnswers([s.question], extra, s.prefix));
      default:
        return "";
    }
  }

  function labelOf(s: Screen): string {
    switch (s.kind) {
      case "field":
        return cfg[s.key].label.replace(/\s*\(optional\)\s*$/i, "");
      case "location":
        return "Location";
      case "links":
        return "Links";
      case "custom":
        return s.question.label;
      default:
        return "";
    }
  }

  return (
    <section aria-labelledby="review-heading">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-phosphor-ink">Review</p>
      <h1
        id="review-heading"
        tabIndex={-1}
        className="mt-4 font-display text-[clamp(2.5rem,7vw,3.75rem)] leading-[1.04] text-ink outline-none"
      >
        {name ? `Looking good, ${name}.` : "Looking good."}
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-soft">
        Give your answers a last look. Once you submit, they&apos;re locked in for review.
      </p>

      {needs.length > 0 && (
        <div role="alert" className="mt-6 max-w-xl border-l-2 border-[#B42318] bg-wash p-4 text-sm dark:border-red-300">
          <p className="font-semibold text-ink">
            {needs.length === 1 ? "One answer still needs you." : `${needs.length} answers still need you.`}
          </p>
          <ul className="mt-2 space-y-1">
            {needs.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onEdit(s.id)} className="link-ink text-left">
                  {labelOf(s)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="mt-8 border-t border-line">
        <ReviewRow
          label="Cohort"
          value={`${cohort.name} · ${cohort.dates}`}
          onEdit={canChangeCohort ? () => onEdit("cohort") : undefined}
          editLabel="Change"
        />
        {rows.map((s) => {
          const value = valueOf(s);
          const missing = screenFieldNames(s).some((n) => errors[n]);
          return (
            <ReviewRow
              key={s.id}
              label={labelOf(s)}
              value={value}
              missing={missing}
              multiline={
                (s.kind === "field" && cfg[s.key].type === "textarea") ||
                s.kind === "links" ||
                (s.kind === "custom" && s.question.type === "textarea")
              }
              onEdit={() => onEdit(s.id)}
            />
          );
        })}
      </dl>

      <div className="mt-8 max-w-xl text-sm leading-relaxed text-ink-soft">
        Applying is free. Tuition ({cohort.priceLabel}) is charged only if you&apos;re accepted, and you&apos;ll
        see your final amount before paying.
      </div>

      {submitError && <ErrorNote>{submitError}</ErrorNote>}

      <div className="mt-8">
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending}
          className="inline-flex h-14 items-center gap-2 rounded-md bg-phosphor px-8 text-base font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Submitting…
            </>
          ) : (
            <>
              Submit application <ArrowRight className="h-4 w-4" aria-hidden />
            </>
          )}
        </button>
      </div>
    </section>
  );
}

function ReviewRow({
  label,
  value,
  missing,
  multiline,
  onEdit,
  editLabel = "Edit",
}: {
  label: string;
  value: string;
  missing?: boolean;
  multiline?: boolean;
  onEdit?: () => void;
  editLabel?: string;
}) {
  // Only <dt> and <dd> may sit in a <dl> group, so the Edit button lives
  // inside the <dd> and is positioned to the row's top-right from there.
  return (
    <div className="relative grid grid-cols-1 gap-y-1 border-b border-line py-4 sm:grid-cols-[12rem_1fr] sm:gap-x-4">
      <dt className="pr-20 font-mono text-xs uppercase tracking-[0.12em] text-ink-faint sm:pr-0 sm:pt-0.5">
        {label}
      </dt>
      <dd
        className={`min-w-0 text-[15px] leading-relaxed sm:pr-20 ${
          multiline ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "[overflow-wrap:anywhere]"
        } ${missing ? "text-[#B42318] dark:text-red-300" : value ? "text-ink" : "text-ink-faint"}`}
      >
        {missing ? "Needs an answer" : value || "—"}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`${editLabel} ${label}`}
            // items-start: touch devices give buttons a 36px minimum height
            // (globals.css), which would otherwise centre the word below the
            // label it belongs to. The tap target keeps its size.
            className="absolute right-0 top-4 flex items-start text-sm leading-4 text-ink-soft underline decoration-line decoration-2 underline-offset-4 hover:text-ink hover:decoration-phosphor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor"
          >
            {editLabel}
          </button>
        )}
      </dd>
    </div>
  );
}
