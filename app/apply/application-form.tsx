"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import {
  saveDraftAction,
  submitApplicationAction,
  attachReferralCodeAction,
} from "./actions";
import type { Application } from "@/lib/types";
import { Check, Loader2, AlertCircle } from "lucide-react";
import { IdeaValidator } from "./idea-validate";
import {
  QUESTION_FIELDS,
  isRequiredCore,
  type MergedQuestion,
} from "@/lib/application-questions";
import { REF_STORAGE_KEY, readRefFromLocation } from "@/lib/referral-code";

const STEPS = [
  { id: 1, title: "About you" },
  { id: 2, title: "Background" },
  { id: 3, title: "Your idea" },
  { id: 4, title: "Review & submit" },
] as const;

// Theme-native field styling. The shared Input/Textarea components ship dark
// literals; we append these tokens so they override to the marketing surface
// (works in light + dark). Kept in one place so every field stays consistent.
const FIELD_CLASS =
  "bg-paper border-line text-ink placeholder:text-ink-faint focus:border-phosphor";

type FormState = {
  full_name: string;
  age: string;
  grade: string;
  school: string;
  city: string;
  country: string;
  parent_email: string;
  why_join: string;
  startup_idea: string;
  experience: string;
  hours_per_week: string;
  team_size: string;
  referral_source: string;
  linkedin_url: string;
  resume_url: string;
  portfolio_url: string;
};

const URL_RE = /^https?:\/\/.+/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Resolved, per-render view of the (admin-editable) question config. Keyed by
// field key. Always has an entry for every fixed field — see buildConfig.
type QuestionMap = Record<string, MergedQuestion>;

function buildConfig(questions: MergedQuestion[] | undefined): QuestionMap {
  const map: QuestionMap = {};
  // Seed with code defaults so a missing/partial prop can never leave a field
  // undefined — the form still renders even if the config fetch returned less.
  for (const f of QUESTION_FIELDS) map[f.key] = { ...f };
  for (const q of questions ?? []) map[q.key] = q;
  return map;
}

/** Whether a field should be shown. Server-required cores are never hidden. */
function isVisible(cfg: QuestionMap, key: string): boolean {
  if (isRequiredCore(key)) return true;
  return !cfg[key]?.hidden;
}

/** Whether a field is required per config (cores are always required). The
 *  parent_email age-conditional rule is layered on top by the caller. */
function isRequired(cfg: QuestionMap, key: string): boolean {
  if (isRequiredCore(key)) return true;
  return !!cfg[key]?.required;
}

function teamSizeLabel(cfg: QuestionMap, value: string): string {
  const opt = cfg.team_size?.options?.find((o) => String(o.value) === value);
  return opt?.label ?? "";
}

// Per-step required-field validation (mirrors the server SubmitSchema).
// Hidden fields are skipped; the `*`/required rules follow the config, with the
// parent_email age-conditional rule preserved on top.
function validateStep(
  step: number,
  form: FormState,
  cfg: QuestionMap,
): Record<string, string> {
  const errs: Record<string, string> = {};
  if (step === 1) {
    if (!form.full_name.trim()) errs.full_name = "Required";
    const ageNum = parseInt(form.age, 10);
    if (!form.age) errs.age = "Required";
    else if (Number.isNaN(ageNum) || ageNum < 10 || ageNum > 25) {
      errs.age = "Enter a valid age (10–25)";
    }
    // Parent/guardian email is required for under-18 applicants —
    // mirrors the SubmitSchema rule and satisfies the parental-consent
    // claim made in the Terms of Service. Only validated when the field
    // is visible.
    if (isVisible(cfg, "parent_email")) {
      const isMinor = !Number.isNaN(ageNum) && ageNum < 18;
      const required = isMinor || isRequired(cfg, "parent_email");
      if (required && !form.parent_email.trim()) {
        errs.parent_email = isMinor
          ? "Required if you're under 18"
          : "Required";
      } else if (form.parent_email && !EMAIL_RE.test(form.parent_email)) {
        errs.parent_email = "Must be a valid email";
      }
    }
  }
  if (step === 2) {
    if (
      isVisible(cfg, "linkedin_url") &&
      form.linkedin_url &&
      !URL_RE.test(form.linkedin_url)
    ) {
      errs.linkedin_url = "Must start with http(s)://";
    }
    if (
      isVisible(cfg, "resume_url") &&
      form.resume_url &&
      !URL_RE.test(form.resume_url)
    ) {
      errs.resume_url = "Must start with http(s)://";
    }
    if (
      isVisible(cfg, "portfolio_url") &&
      form.portfolio_url &&
      !URL_RE.test(form.portfolio_url)
    ) {
      errs.portfolio_url = "Must start with http(s)://";
    }
  }
  if (step === 3) {
    const whyLen = form.why_join.trim().length;
    if (whyLen < 40) {
      errs.why_join =
        whyLen === 0
          ? "Required — at least 40 characters"
          : `Needs at least 40 characters — you're at ${whyLen}`;
    }
    const sizeNum = parseInt(form.team_size, 10);
    if (!form.team_size) {
      errs.team_size = "Pick a team size";
    } else if (Number.isNaN(sizeNum) || sizeNum < 1 || sizeNum > 5) {
      errs.team_size = "Pick a team size";
    }
  }
  return errs;
}

function buildFormData(form: FormState, cohortId?: string | null) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  if (cohortId) fd.append("cohort_id", cohortId);
  return fd;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

export function ApplicationForm({
  defaults,
  email,
  priceLabel = "$130",
  cohortId = null,
  questions,
}: {
  defaults: Application | null;
  email: string;
  priceLabel?: string;
  /** Cohort the applicant is targeting. Selected on the /apply page;
   *  sent up with every draft save + final submit so the server-side
   *  action can attach the row to that cohort. */
  cohortId?: string | null;
  /** Admin-editable question content (labels/help/placeholder/required/
   *  hidden + team_size option labels). Resolved server-side; falls back
   *  to code defaults per key if omitted. */
  questions?: MergedQuestion[];
}) {
  const cfg = useMemo(() => buildConfig(questions), [questions]);

  const [step, setStep] = useState(1);
  const [submitPending, startSubmit] = useTransition();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveStatus>({ kind: "idle" });
  // Steps where the user has already tried to continue. From that moment the
  // step validates LIVE: errors appear on the click, then update keystroke by
  // keystroke until everything's fixed — no dead buttons, no silent refusals.
  const [attempted, setAttempted] = useState<Record<number, boolean>>({});
  // Brief shake on Next when the click is refused, so the "no" is felt even
  // before the error summary is read.
  const [shakeNext, setShakeNext] = useState(false);

  const [form, setForm] = useState<FormState>({
    full_name: defaults?.full_name ?? "",
    age: defaults?.age?.toString() ?? "",
    grade: defaults?.grade ?? "",
    school: defaults?.school ?? "",
    city: defaults?.city ?? "",
    country: defaults?.country ?? "",
    parent_email: defaults?.parent_email ?? "",
    why_join: defaults?.why_join ?? "",
    startup_idea: defaults?.startup_idea ?? "",
    experience: defaults?.experience ?? "",
    hours_per_week: defaults?.hours_per_week?.toString() ?? "",
    team_size: defaults?.team_size?.toString() ?? "",
    referral_source: defaults?.referral_source ?? "",
    linkedin_url: defaults?.linkedin_url ?? "",
    resume_url: defaults?.resume_url ?? "",
    portfolio_url: defaults?.portfolio_url ?? "",
  });

  // Pick up a referral code stashed at signup (or from ?ref= here).
  // We use a dedicated server action so we don't blow away every other
  // field on the existing draft by sending only the referral_code key.
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep an always-current ref to form state for the autosave timer
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  function set<K extends keyof FormState>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => ({ ...e, [k]: "" }));
  }

  // Autosave: debounce 1.5s after the last keystroke. The initial mount
  // is intentionally skipped — without that guard, just loading the
  // form re-saved the existing draft once, burning a DB write + audit
  // log entry for every visit.
  const dirtyRef = useRef(false);
  const firstAutosaveRef = useRef(true);
  useEffect(() => {
    if (firstAutosaveRef.current) {
      firstAutosaveRef.current = false;
      return;
    }
    dirtyRef.current = true;
    const timer = setTimeout(async () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setSave({ kind: "saving" });
      try {
        const result = await saveDraftAction(
          null,
          buildFormData(formRef.current, cohortId),
        );
        if (result.ok) {
          setSave({ kind: "saved", at: new Date() });
        } else {
          // Reflect the failure so the user knows the keystrokes
          // weren't persisted. Also keep dirty=true so the next save
          // tick will retry rather than silently dropping the change.
          dirtyRef.current = true;
          setSave({
            kind: "error",
            message: result.error ?? "Couldn't save draft",
          });
        }
      } catch (err) {
        dirtyRef.current = true;
        setSave({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Couldn't save draft",
        });
      }
    }, 1500);
    return () => clearTimeout(timer);
    // Keying the effect on form serialized ensures any change schedules a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.full_name,
    form.age,
    form.grade,
    form.school,
    form.city,
    form.country,
    form.parent_email,
    form.why_join,
    form.startup_idea,
    form.experience,
    form.hours_per_week,
    form.team_size,
    form.referral_source,
    form.linkedin_url,
    form.resume_url,
    form.portfolio_url,
  ]);

  // Save on unload / tab hidden so a closed tab keeps the latest draft.
  useEffect(() => {
    const flush = () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      // Fire-and-forget; we don't await on unload.
      saveDraftAction(null, buildFormData(formRef.current, cohortId));
    };
    const onVis = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Scroll-focus the first invalid field on the next paint. Without
  // this, the error-state border could end up off-screen and the
  // "highlighted fields" message felt like a lie.
  function focusFirstError(errs: Record<string, string>) {
    if (typeof window === "undefined") return;
    const firstKey = Object.keys(errs)[0];
    if (!firstKey) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(firstKey) as
        | HTMLElement
        | null;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (typeof (el as any).focus === "function") {
        try {
          (el as HTMLInputElement).focus({ preventScroll: true });
        } catch {}
      }
    });
  }

  function goNext() {
    const errs = validateStep(step, form, cfg);
    setAttempted((a) => ({ ...a, [step]: true }));
    if (Object.keys(errs).length > 0) {
      setFieldErrors((prev) => ({ ...prev, ...errs }));
      focusFirstError(errs);
      setShakeNext(true);
      window.setTimeout(() => setShakeNext(false), 450);
      return;
    }
    setStep(step + 1);
  }

  function handleSubmit() {
    // Run validation across every step before submit.
    const errs: Record<string, string> = {};
    for (let s = 1; s <= STEPS.length; s++) {
      Object.assign(errs, validateStep(s, form, cfg));
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setAttempted({ 1: true, 2: true, 3: true, 4: true });
      // Jump to the first step with an error.
      let firstErrorStep = step;
      for (const s of [1, 2, 3] as const) {
        if (Object.keys(validateStep(s, form, cfg)).length > 0) {
          firstErrorStep = s;
          setStep(s);
          break;
        }
      }
      setSubmitError("Please fix the highlighted fields.");
      // Defer the scroll/focus until the step has actually rendered.
      setTimeout(
        () => focusFirstError(validateStep(firstErrorStep, form, cfg)),
        80,
      );
      return;
    }
    setSubmitError(undefined);
    startSubmit(async () => {
      const result = await submitApplicationAction(
        null,
        buildFormData(form, cohortId),
      );
      if (!result.ok) {
        setSubmitError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        if (result.fieldErrors) focusFirstError(result.fieldErrors);
      }
    });
  }

  const stepHasErrors = (s: number) =>
    Object.keys(validateStep(s, form, cfg)).length > 0;

  // Live validation for the current step — only once the user has tried to
  // continue. Merged with server-reported errors per field, so a message
  // vanishes the moment the fix lands and reappears if they re-break it.
  const liveErrs = attempted[step] ? validateStep(step, form, cfg) : {};
  const liveErrKeys = Object.keys(liveErrs);
  const errFor = (key: string) => fieldErrors[key] || liveErrs[key] || "";

  // Human label for the error summary list.
  const labelFor = (key: string) =>
    cfg[key]?.label ?? key.replace(/_/g, " ");

  function jumpToField(key: string) {
    focusFirstError({ [key]: "jump" });
  }

  // Long-answer progress: mirrors validateStep's 40-char minimum on why_join
  // so the counter, the bar, and the rule can never disagree.
  const WHY_MIN = 40;
  const whyLen = form.why_join.trim().length;
  const whyMet = whyLen >= WHY_MIN;

  // Derive parent-email requirement from the current age value. Used
  // both to enforce HTML-level required + aria-required and to swap the
  // placeholder copy so the user knows why the field has lit up. Layered
  // on top of the admin `required` config.
  const ageNum = parseInt(form.age, 10);
  const parentEmailAgeRequired = !Number.isNaN(ageNum) && ageNum < 18;
  const parentEmailRequired =
    parentEmailAgeRequired || isRequired(cfg, "parent_email");

  // Required-marker helper for a config-driven field.
  const reqMark = (key: string) =>
    isRequired(cfg, key) ? (
      <span aria-hidden className="text-phosphor-ink">
        *
      </span>
    ) : null;

  const show = (key: string) => isVisible(cfg, key);

  return (
    <div className="rounded-2xl border border-line bg-wash p-5 sm:p-6 md:p-8">
      {/* Mobile stepper: compact progress + current label only. The full
          4-up stepper wraps awkwardly under 380px. */}
      <div
        className="mb-6 sm:hidden"
        aria-label={`Application progress: step ${step} of ${STEPS.length}`}
      >
        <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.18em]">
          <span className="text-phosphor-ink">
            Step {step} of {STEPS.length}
          </span>
          <span className="text-ink-soft">
            {STEPS.find((s) => s.id === step)?.title}
          </span>
        </div>
        <div
          aria-hidden
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line"
        >
          <div
            className="h-full bg-phosphor transition-all duration-300"
            style={{ width: `${(step / STEPS.length) * 100}%` }}
          />
        </div>
        <div className="mt-3 flex items-center gap-1.5">
          {STEPS.map((s) => {
            const hasErr = stepHasErrors(s.id) && step > s.id;
            const isCurrent = step === s.id;
            const reached = step >= s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                aria-label={`Jump to step ${s.id}: ${s.title}`}
                aria-current={isCurrent ? "step" : undefined}
                className={`flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-medium ${
                  isCurrent
                    ? "border-phosphor bg-phosphor text-on-phosphor"
                    : reached
                      ? hasErr
                        ? "border-red-400/60 bg-red-400/10 text-red-500"
                        : "border-phosphor/40 bg-phosphor/10 text-phosphor-ink"
                      : "border-line text-ink-faint"
                }`}
              >
                {hasErr ? <AlertCircle className="h-3.5 w-3.5" /> : s.id}
              </button>
            );
          })}
        </div>
      </div>

      {/* Desktop stepper */}
      <ol
        className="mb-8 hidden sm:flex flex-wrap items-center gap-2 text-xs"
        aria-label={`Application progress: step ${step} of ${STEPS.length}`}
      >
        {STEPS.map((s, i) => {
          const reached = step >= s.id;
          const hasErr = stepHasErrors(s.id) && step > s.id;
          const isCurrent = step === s.id;
          return (
            <li key={s.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep(s.id)}
                aria-label={`Step ${s.id}: ${s.title}${hasErr ? " (has errors)" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                className="group inline-flex items-center gap-2 rounded-full py-0.5 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor/60"
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-medium ${
                    isCurrent
                      ? "border-phosphor bg-phosphor text-on-phosphor"
                      : reached
                        ? hasErr
                          ? "border-red-400/60 bg-red-400/10 text-red-500"
                          : "border-phosphor/40 bg-phosphor/10 text-phosphor-ink"
                        : "border-line text-ink-faint group-hover:border-ink/30 group-hover:text-ink-soft"
                  }`}
                >
                  {hasErr ? <AlertCircle className="h-3.5 w-3.5" /> : s.id}
                </span>
                <span
                  className={
                    isCurrent
                      ? "text-ink"
                      : "text-ink-faint group-hover:text-ink-soft"
                  }
                >
                  {s.title}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <span aria-hidden className="mx-1 text-ink-faint">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label htmlFor="account_email">Account email</Label>
            <Input
              id="account_email"
              className={FIELD_CLASS}
              value={email}
              disabled
              autoComplete="email"
            />
          </div>
          {show("full_name") && (
            <div className="md:col-span-2">
              <Label htmlFor="full_name" required={isRequired(cfg, "full_name")}>
                {cfg.full_name.label} {reqMark("full_name")}
              </Label>
              <Input
                id="full_name"
                className={FIELD_CLASS}
                autoComplete="name"
                required={isRequired(cfg, "full_name")}
                aria-required={isRequired(cfg, "full_name") || undefined}
                error={errFor("full_name")}
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                placeholder={cfg.full_name.placeholder || undefined}
              />
              <FieldError id="full_name-error">
                {errFor("full_name")}
              </FieldError>
              {cfg.full_name.help && (
                <p className="mt-1 text-xs text-ink-soft">
                  {cfg.full_name.help}
                </p>
              )}
            </div>
          )}
          {show("age") && (
            <div>
              <Label htmlFor="age" required={isRequired(cfg, "age")}>
                {cfg.age.label} {reqMark("age")}
              </Label>
              <Input
                id="age"
                className={FIELD_CLASS}
                type="number"
                inputMode="numeric"
                min={10}
                max={25}
                required={isRequired(cfg, "age")}
                aria-required={isRequired(cfg, "age") || undefined}
                error={errFor("age")}
                value={form.age}
                onChange={(e) => set("age", e.target.value)}
                placeholder={cfg.age.placeholder || undefined}
              />
              <FieldError id="age-error">{errFor("age")}</FieldError>
              {cfg.age.help && (
                <p className="mt-1 text-xs text-ink-soft">{cfg.age.help}</p>
              )}
            </div>
          )}
          {show("grade") && (
            <div>
              <Label htmlFor="grade" required={isRequired(cfg, "grade")}>
                {cfg.grade.label} {reqMark("grade")}
              </Label>
              <Input
                id="grade"
                className={FIELD_CLASS}
                value={form.grade}
                onChange={(e) => set("grade", e.target.value)}
                placeholder={cfg.grade.placeholder || undefined}
                required={isRequired(cfg, "grade")}
                aria-required={isRequired(cfg, "grade") || undefined}
              />
              {cfg.grade.help && (
                <p className="mt-1 text-xs text-ink-soft">{cfg.grade.help}</p>
              )}
            </div>
          )}
          {show("school") && (
            <div className="md:col-span-2">
              <Label htmlFor="school" required={isRequired(cfg, "school")}>
                {cfg.school.label} {reqMark("school")}
              </Label>
              <Input
                id="school"
                className={FIELD_CLASS}
                autoComplete="organization"
                value={form.school}
                onChange={(e) => set("school", e.target.value)}
                placeholder={cfg.school.placeholder || undefined}
                required={isRequired(cfg, "school")}
                aria-required={isRequired(cfg, "school") || undefined}
              />
              {cfg.school.help && (
                <p className="mt-1 text-xs text-ink-soft">{cfg.school.help}</p>
              )}
            </div>
          )}
          {show("city") && (
            <div>
              <Label htmlFor="city" required={isRequired(cfg, "city")}>
                {cfg.city.label} {reqMark("city")}
              </Label>
              <Input
                id="city"
                className={FIELD_CLASS}
                autoComplete="address-level2"
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
                placeholder={cfg.city.placeholder || undefined}
                required={isRequired(cfg, "city")}
                aria-required={isRequired(cfg, "city") || undefined}
              />
              {cfg.city.help && (
                <p className="mt-1 text-xs text-ink-soft">{cfg.city.help}</p>
              )}
            </div>
          )}
          {show("country") && (
            <div>
              <Label htmlFor="country" required={isRequired(cfg, "country")}>
                {cfg.country.label} {reqMark("country")}
              </Label>
              <Input
                id="country"
                className={FIELD_CLASS}
                autoComplete="country-name"
                value={form.country}
                onChange={(e) => set("country", e.target.value)}
                placeholder={cfg.country.placeholder || undefined}
                required={isRequired(cfg, "country")}
                aria-required={isRequired(cfg, "country") || undefined}
              />
              {cfg.country.help && (
                <p className="mt-1 text-xs text-ink-soft">{cfg.country.help}</p>
              )}
            </div>
          )}
          {show("parent_email") && (
            <div className="md:col-span-2">
              <Label htmlFor="parent_email">
                {cfg.parent_email.label}{" "}
                {parentEmailRequired && (
                  <>
                    <span aria-hidden className="text-phosphor-ink">
                      *
                    </span>
                    <span className="sr-only"> required</span>
                  </>
                )}
              </Label>
              <Input
                id="parent_email"
                className={FIELD_CLASS}
                type="email"
                autoComplete="email"
                required={parentEmailRequired}
                aria-required={parentEmailRequired || undefined}
                error={errFor("parent_email")}
                value={form.parent_email}
                onChange={(e) => set("parent_email", e.target.value)}
                placeholder={
                  parentEmailAgeRequired
                    ? "Required — you're under 18"
                    : cfg.parent_email.placeholder || undefined
                }
              />
              <FieldError id="parent_email-error">
                {errFor("parent_email")}
              </FieldError>
              {cfg.parent_email.help && (
                <p className="mt-1 text-xs text-ink-soft">
                  {cfg.parent_email.help}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {show("experience") && (
            <div>
              <Label
                htmlFor="experience"
                required={isRequired(cfg, "experience")}
              >
                {cfg.experience.label} {reqMark("experience")}
              </Label>
              <Textarea
                id="experience"
                className={FIELD_CLASS}
                rows={5}
                value={form.experience}
                onChange={(e) => set("experience", e.target.value)}
                placeholder={cfg.experience.placeholder || undefined}
                required={isRequired(cfg, "experience")}
                aria-required={isRequired(cfg, "experience") || undefined}
              />
              {cfg.experience.help && (
                <p className="mt-1 text-xs text-ink-soft">
                  {cfg.experience.help}
                </p>
              )}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {show("hours_per_week") && (
              <div>
                <Label
                  htmlFor="hours_per_week"
                  required={isRequired(cfg, "hours_per_week")}
                >
                  {cfg.hours_per_week.label} {reqMark("hours_per_week")}
                </Label>
                <Input
                  id="hours_per_week"
                  className={FIELD_CLASS}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={168}
                  value={form.hours_per_week}
                  onChange={(e) => set("hours_per_week", e.target.value)}
                  placeholder={cfg.hours_per_week.placeholder || undefined}
                  required={isRequired(cfg, "hours_per_week")}
                  aria-required={
                    isRequired(cfg, "hours_per_week") || undefined
                  }
                />
                {cfg.hours_per_week.help && (
                  <p className="mt-1 text-xs text-ink-soft">
                    {cfg.hours_per_week.help}
                  </p>
                )}
              </div>
            )}
            {show("referral_source") && (
              <div>
                <Label
                  htmlFor="referral_source"
                  required={isRequired(cfg, "referral_source")}
                >
                  {cfg.referral_source.label} {reqMark("referral_source")}
                </Label>
                <Input
                  id="referral_source"
                  className={FIELD_CLASS}
                  value={form.referral_source}
                  onChange={(e) => set("referral_source", e.target.value)}
                  placeholder={cfg.referral_source.placeholder || undefined}
                  required={isRequired(cfg, "referral_source")}
                  aria-required={
                    isRequired(cfg, "referral_source") || undefined
                  }
                />
                {cfg.referral_source.help && (
                  <p className="mt-1 text-xs text-ink-soft">
                    {cfg.referral_source.help}
                  </p>
                )}
              </div>
            )}
          </div>
          {(show("linkedin_url") ||
            show("resume_url") ||
            show("portfolio_url")) && (
            <div className="rounded-xl border border-line bg-paper p-4">
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-phosphor-ink">
                Links (optional)
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Anything that helps us see what you've built.
              </p>
              <div className="mt-4 space-y-3">
                {show("linkedin_url") && (
                  <div>
                    <Label
                      htmlFor="linkedin_url"
                      required={isRequired(cfg, "linkedin_url")}
                    >
                      {cfg.linkedin_url.label} {reqMark("linkedin_url")}
                    </Label>
                    <Input
                      id="linkedin_url"
                      className={FIELD_CLASS}
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      placeholder={cfg.linkedin_url.placeholder || undefined}
                      error={errFor("linkedin_url")}
                      value={form.linkedin_url}
                      onChange={(e) => set("linkedin_url", e.target.value)}
                      required={isRequired(cfg, "linkedin_url")}
                      aria-required={
                        isRequired(cfg, "linkedin_url") || undefined
                      }
                    />
                    <FieldError id="linkedin_url-error">
                      {errFor("linkedin_url")}
                    </FieldError>
                    {cfg.linkedin_url.help && (
                      <p className="mt-1 text-xs text-ink-soft">
                        {cfg.linkedin_url.help}
                      </p>
                    )}
                  </div>
                )}
                {show("resume_url") && (
                  <div>
                    <Label
                      htmlFor="resume_url"
                      required={isRequired(cfg, "resume_url")}
                    >
                      {cfg.resume_url.label} {reqMark("resume_url")}
                    </Label>
                    <Input
                      id="resume_url"
                      className={FIELD_CLASS}
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      placeholder={cfg.resume_url.placeholder || undefined}
                      error={errFor("resume_url")}
                      value={form.resume_url}
                      onChange={(e) => set("resume_url", e.target.value)}
                      required={isRequired(cfg, "resume_url")}
                      aria-required={
                        isRequired(cfg, "resume_url") || undefined
                      }
                    />
                    <FieldError id="resume_url-error">
                      {errFor("resume_url")}
                    </FieldError>
                    {cfg.resume_url.help && (
                      <p className="mt-1 text-xs text-ink-soft">
                        {cfg.resume_url.help}
                      </p>
                    )}
                  </div>
                )}
                {show("portfolio_url") && (
                  <div>
                    <Label
                      htmlFor="portfolio_url"
                      required={isRequired(cfg, "portfolio_url")}
                    >
                      {cfg.portfolio_url.label} {reqMark("portfolio_url")}
                    </Label>
                    <Input
                      id="portfolio_url"
                      className={FIELD_CLASS}
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      placeholder={cfg.portfolio_url.placeholder || undefined}
                      error={errFor("portfolio_url")}
                      value={form.portfolio_url}
                      onChange={(e) => set("portfolio_url", e.target.value)}
                      required={isRequired(cfg, "portfolio_url")}
                      aria-required={
                        isRequired(cfg, "portfolio_url") || undefined
                      }
                    />
                    <FieldError id="portfolio_url-error">
                      {errFor("portfolio_url")}
                    </FieldError>
                    {cfg.portfolio_url.help && (
                      <p className="mt-1 text-xs text-ink-soft">
                        {cfg.portfolio_url.help}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="why_join" required={isRequired(cfg, "why_join")}>
              {cfg.why_join.label} {reqMark("why_join")}
            </Label>
            <Textarea
              id="why_join"
              className={FIELD_CLASS}
              rows={6}
              required={isRequired(cfg, "why_join")}
              aria-required={isRequired(cfg, "why_join") || undefined}
              error={errFor("why_join")}
              aria-describedby="why_join-counter"
              value={form.why_join}
              onChange={(e) => set("why_join", e.target.value)}
              placeholder={cfg.why_join.placeholder || undefined}
            />
            {/* Live progress toward the 40-char minimum: bar + counter shift
                amber → green the moment the requirement is met, so nobody
                discovers the rule only by being refused at Next. */}
            <div
              aria-hidden
              className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-line"
            >
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  whyMet ? "bg-emerald-500" : "bg-amber-500"
                }`}
                style={{
                  width: `${Math.min(100, (whyLen / WHY_MIN) * 100)}%`,
                }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-xs">
              <FieldError id="why_join-error">
                {errFor("why_join")}
              </FieldError>
              <span
                id="why_join-counter"
                aria-live="polite"
                className={
                  whyMet
                    ? "inline-flex shrink-0 items-center gap-1 text-emerald-600 dark:text-emerald-400"
                    : whyLen > 0
                      ? "shrink-0 text-amber-600 dark:text-amber-400"
                      : "shrink-0 text-ink-faint"
                }
              >
                {whyMet ? (
                  <>
                    <Check className="h-3 w-3" aria-hidden />
                    {whyLen} characters — good to go
                  </>
                ) : whyLen > 0 ? (
                  `${WHY_MIN - whyLen} more character${WHY_MIN - whyLen === 1 ? "" : "s"} to go`
                ) : (
                  `${WHY_MIN} characters minimum`
                )}
              </span>
            </div>
            {cfg.why_join.help && (
              <p className="mt-1 text-xs text-ink-soft">{cfg.why_join.help}</p>
            )}
          </div>
          {show("startup_idea") && (
            <div>
              <Label
                htmlFor="startup_idea"
                required={isRequired(cfg, "startup_idea")}
              >
                {cfg.startup_idea.label} {reqMark("startup_idea")}
              </Label>
              <Textarea
                id="startup_idea"
                className={FIELD_CLASS}
                rows={6}
                value={form.startup_idea}
                onChange={(e) => set("startup_idea", e.target.value)}
                placeholder={cfg.startup_idea.placeholder || undefined}
                required={isRequired(cfg, "startup_idea")}
                aria-required={isRequired(cfg, "startup_idea") || undefined}
              />
              {cfg.startup_idea.help && (
                <p className="mt-1 text-xs text-ink-soft">
                  {cfg.startup_idea.help}
                </p>
              )}
              <IdeaValidator idea={form.startup_idea} />
            </div>
          )}
          <div>
            <Label required={isRequired(cfg, "team_size")}>
              {cfg.team_size.label} {reqMark("team_size")}
            </Label>
            {cfg.team_size.help && (
              <p className="mt-0.5 mb-2 text-xs text-ink-soft">
                {cfg.team_size.help}
              </p>
            )}
            <div
              id="team_size"
              role="radiogroup"
              aria-label={cfg.team_size.label}
              aria-required="true"
              aria-invalid={errFor("team_size") ? true : undefined}
              tabIndex={-1}
              className={`flex flex-wrap gap-2 rounded-lg ${
                errFor("team_size")
                  ? "ring-1 ring-red-400/40 ring-offset-2 ring-offset-transparent p-2 -m-2"
                  : ""
              }`}
            >
              {(cfg.team_size.options ?? []).map((opt) => {
                const selected = form.team_size === String(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set("team_size", String(opt.value))}
                    className={`rounded-lg border px-3 py-2 text-sm transition active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor/60 ${
                      selected
                        ? "border-phosphor bg-phosphor/15 text-ink"
                        : "border-line bg-paper text-ink-soft hover:border-ink/30 hover:text-ink"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <FieldError id="team_size-error">
              {errFor("team_size")}
            </FieldError>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-paper p-5 text-sm">
            <h4 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-phosphor-ink">
              Review your answers
            </h4>
            {show("full_name") && (
              <ReviewRow label={cfg.full_name.label} value={form.full_name} />
            )}
            {show("age") && (
              <ReviewRow label={cfg.age.label} value={form.age} />
            )}
            {show("grade") && (
              <ReviewRow label={cfg.grade.label} value={form.grade} />
            )}
            {show("school") && (
              <ReviewRow label={cfg.school.label} value={form.school} />
            )}
            {(show("city") || show("country")) && (
              <ReviewRow
                label="Location"
                value={[
                  show("city") ? form.city : "",
                  show("country") ? form.country : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
              />
            )}
            {show("parent_email") && (
              <ReviewRow
                label={cfg.parent_email.label}
                value={form.parent_email}
              />
            )}
            {show("hours_per_week") && (
              <ReviewRow
                label={cfg.hours_per_week.label}
                value={form.hours_per_week}
              />
            )}
            {show("team_size") && (
              <ReviewRow
                label={cfg.team_size.label}
                value={teamSizeLabel(cfg, form.team_size)}
              />
            )}
            {show("referral_source") && (
              <ReviewRow
                label={cfg.referral_source.label}
                value={form.referral_source}
              />
            )}
            {show("linkedin_url") && (
              <ReviewRow
                label={cfg.linkedin_url.label}
                value={form.linkedin_url}
              />
            )}
            {show("resume_url") && (
              <ReviewRow
                label={cfg.resume_url.label}
                value={form.resume_url}
              />
            )}
            {show("portfolio_url") && (
              <ReviewRow
                label={cfg.portfolio_url.label}
                value={form.portfolio_url}
              />
            )}
            {show("why_join") && (
              <ReviewRow
                label={cfg.why_join.label}
                value={form.why_join}
                multiline
              />
            )}
            {show("startup_idea") && (
              <ReviewRow
                label={cfg.startup_idea.label}
                value={form.startup_idea}
                multiline
              />
            )}
            {show("experience") && (
              <ReviewRow
                label={cfg.experience.label}
                value={form.experience}
                multiline
              />
            )}
          </div>
          <div className="rounded-xl border border-phosphor/30 bg-phosphor/5 p-4 text-sm text-ink-soft">
            Submitting moves your application to{" "}
            <span className="text-ink">review</span>. You won't be charged
            anything yet — payment ({priceLabel}) only happens after we accept
            you.
          </div>
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-500"
        >
          {submitError}
        </div>
      )}

      {/* Live step feedback, armed by the first refused Next click: a
          checklist of what's blocking, each entry jumping to its field, that
          updates as they type and flips to a green all-clear at zero. */}
      {attempted[step] && liveErrKeys.length > 0 && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-4 text-sm"
        >
          <p className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            {liveErrKeys.length === 1
              ? "One thing needs fixing before you continue:"
              : `${liveErrKeys.length} things need fixing before you continue:`}
          </p>
          <ul className="mt-2 space-y-1">
            {liveErrKeys.map((key) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => jumpToField(key)}
                  className="text-left text-red-600 underline decoration-red-400/50 underline-offset-2 hover:decoration-red-500 dark:text-red-400"
                >
                  {labelFor(key)}
                </button>{" "}
                <span className="text-ink-soft">— {liveErrs[key]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {attempted[step] && liveErrKeys.length === 0 && step < STEPS.length && (
        <p
          role="status"
          aria-live="polite"
          className="mt-5 inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400"
        >
          <Check className="h-4 w-4" aria-hidden /> All set — hit Next to
          continue.
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <SaveStatusIndicator status={save} />
        <div className="flex items-center gap-2">
          {step > 1 && (
            <Button
              variant="secondary"
              type="button"
              onClick={() => setStep(step - 1)}
              disabled={submitPending}
            >
              Back
            </Button>
          )}
          {step < STEPS.length ? (
            // Deliberately NOT disabled when the step is invalid: a dead
            // button explains nothing (and its hover tooltip never existed
            // on mobile). Clicking runs validation, surfaces the checklist
            // above, focuses the first problem, and shakes to say "no".
            <Button
              type="button"
              onClick={goNext}
              disabled={submitPending}
              className={shakeNext ? "animate-shake" : ""}
            >
              Next
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={submitPending}
            >
              {submitPending ? "Submitting…" : "Submit application"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SaveStatusIndicator({ status }: { status: SaveStatus }) {
  // Wrap in a polite live region so AT users hear "Saving draft…" /
  // "Draft saved" without us hijacking their focus.
  const body =
    status.kind === "saving" ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving draft…
      </span>
    ) : status.kind === "saved" ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500">
        <Check className="h-3 w-3" aria-hidden /> Draft saved at{" "}
        {status.at.toLocaleTimeString()}
      </span>
    ) : status.kind === "error" ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-500">
        <AlertCircle className="h-3 w-3" aria-hidden /> {status.message}
      </span>
    ) : (
      <span className="text-xs text-ink-faint">
        Drafts autosave as you type.
      </span>
    );
  return (
    <span role="status" aria-live="polite" aria-atomic="true">
      {body}
    </span>
  );
}

function ReviewRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div
      className={`flex ${multiline ? "flex-col gap-1" : "items-baseline gap-3"} border-b border-line py-2 last:border-0`}
    >
      <div className="text-xs uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div
        className={`text-ink ${multiline ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "truncate"}`}
      >
        {value || <span className="text-ink-faint">—</span>}
      </div>
    </div>
  );
}
