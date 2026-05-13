"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import {
  saveDraftAction,
  submitApplicationAction,
  attachReferralCodeAction,
} from "./actions";
import type { Application } from "@/lib/types";
import { Check, Loader2, AlertCircle } from "lucide-react";

const STEPS = [
  { id: 1, title: "About you" },
  { id: 2, title: "Background" },
  { id: 3, title: "Your idea" },
  { id: 4, title: "Review & submit" },
] as const;

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
  referral_source: string;
  linkedin_url: string;
  resume_url: string;
  portfolio_url: string;
};

const URL_RE = /^https?:\/\/.+/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Per-step required-field validation (mirrors the server SubmitSchema).
function validateStep(
  step: number,
  form: FormState,
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
    // claim made in the Terms of Service.
    const isMinor = !Number.isNaN(ageNum) && ageNum < 18;
    if (isMinor && !form.parent_email.trim()) {
      errs.parent_email = "Required if you're under 18";
    } else if (form.parent_email && !EMAIL_RE.test(form.parent_email)) {
      errs.parent_email = "Must be a valid email";
    }
  }
  if (step === 2) {
    if (form.linkedin_url && !URL_RE.test(form.linkedin_url)) {
      errs.linkedin_url = "Must start with http(s)://";
    }
    if (form.resume_url && !URL_RE.test(form.resume_url)) {
      errs.resume_url = "Must start with http(s)://";
    }
    if (form.portfolio_url && !URL_RE.test(form.portfolio_url)) {
      errs.portfolio_url = "Must start with http(s)://";
    }
  }
  if (step === 3) {
    if (form.why_join.trim().length < 40) {
      errs.why_join =
        form.why_join.trim().length === 0
          ? "Required"
          : "Tell us at least a couple sentences";
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
  priceLabel = "$97",
  cohortId = null,
}: {
  defaults: Application | null;
  email: string;
  priceLabel?: string;
  /** Cohort the applicant is targeting. Selected on the /apply page;
   *  sent up with every draft save + final submit so the server-side
   *  action can attach the row to that cohort. */
  cohortId?: string | null;
}) {
  const [step, setStep] = useState(1);
  const [submitPending, startSubmit] = useTransition();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveStatus>({ kind: "idle" });

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
    referral_source: defaults?.referral_source ?? "",
    linkedin_url: defaults?.linkedin_url ?? "",
    resume_url: defaults?.resume_url ?? "",
    portfolio_url: defaults?.portfolio_url ?? "",
  });

  // Pick up a referral code stashed at signup (or from ?ref= here).
  // We use a dedicated server action so we don't blow away every other
  // field on the existing draft by sending only the referral_code key.
  useEffect(() => {
    const fromUrl = new URL(window.location.href).searchParams.get("ref");
    let code = "";
    try {
      code = fromUrl ?? window.localStorage.getItem("sparkline_ref") ?? "";
    } catch {}
    if (code) {
      attachReferralCodeAction(code).catch(() => {});
      try {
        window.localStorage.removeItem("sparkline_ref");
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

  // Autosave: debounce 1.5s after the last keystroke.
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = true;
    const timer = setTimeout(async () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setSave({ kind: "saving" });
      const result = await saveDraftAction(null, buildFormData(formRef.current, cohortId));
      if (result.ok) {
        setSave({ kind: "saved", at: new Date() });
      } else {
        setSave({
          kind: "error",
          message: result.error ?? "Couldn't save draft",
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

  function goNext() {
    const errs = validateStep(step, form);
    if (Object.keys(errs).length > 0) {
      setFieldErrors((prev) => ({ ...prev, ...errs }));
      return;
    }
    setStep(step + 1);
  }

  function handleSubmit() {
    // Run validation across every step before submit.
    const errs: Record<string, string> = {};
    for (let s = 1; s <= STEPS.length; s++) {
      Object.assign(errs, validateStep(s, form));
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      // Jump to the first step with an error.
      for (const s of [1, 2, 3] as const) {
        if (Object.keys(validateStep(s, form)).length > 0) {
          setStep(s);
          break;
        }
      }
      setSubmitError("Please fix the highlighted fields.");
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
      }
    });
  }

  const stepHasErrors = (s: number) =>
    Object.keys(validateStep(s, form)).length > 0;

  // Derive parent-email requirement from the current age value. Used
  // both to enforce HTML-level required + aria-required and to swap the
  // placeholder copy so the user knows why the field has lit up.
  const ageNum = parseInt(form.age, 10);
  const parentEmailRequired = !Number.isNaN(ageNum) && ageNum < 18;

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/40 p-6 md:p-8">
      {/* Stepper */}
      <ol
        className="mb-8 flex flex-wrap items-center gap-2 text-xs"
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
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-medium ${
                  isCurrent
                    ? "border-spark bg-spark text-black"
                    : reached
                      ? hasErr
                        ? "border-red-400/60 bg-red-400/10 text-red-300"
                        : "border-spark/40 bg-spark/10 text-spark"
                      : "border-white/15 text-white/40"
                }`}
              >
                {hasErr ? <AlertCircle className="h-3.5 w-3.5" /> : s.id}
              </button>
              <span className={isCurrent ? "text-white" : "text-white/45"}>
                {s.title}
              </span>
              {i < STEPS.length - 1 && (
                <span aria-hidden className="mx-1 text-white/25">›</span>
              )}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label htmlFor="account_email">Account email</Label>
            <Input id="account_email" value={email} disabled autoComplete="email" />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="full_name" required>
              Full name <span aria-hidden className="text-spark">*</span>
            </Label>
            <Input
              id="full_name"
              autoComplete="name"
              required
              aria-required="true"
              error={fieldErrors.full_name}
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
            />
            <FieldError id="full_name-error">{fieldErrors.full_name}</FieldError>
          </div>
          <div>
            <Label htmlFor="age" required>
              Age <span aria-hidden className="text-spark">*</span>
            </Label>
            <Input
              id="age"
              type="number"
              inputMode="numeric"
              min={10}
              max={25}
              required
              aria-required="true"
              error={fieldErrors.age}
              value={form.age}
              onChange={(e) => set("age", e.target.value)}
            />
            <FieldError id="age-error">{fieldErrors.age}</FieldError>
          </div>
          <div>
            <Label htmlFor="grade">Grade</Label>
            <Input
              id="grade"
              value={form.grade}
              onChange={(e) => set("grade", e.target.value)}
              placeholder="e.g. 11th"
            />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="school">School</Label>
            <Input
              id="school"
              autoComplete="organization"
              value={form.school}
              onChange={(e) => set("school", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              autoComplete="address-level2"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="country">Country</Label>
            <Input
              id="country"
              autoComplete="country-name"
              value={form.country}
              onChange={(e) => set("country", e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="parent_email">
              Parent / guardian email{" "}
              {parentEmailRequired && (
                <>
                  <span aria-hidden className="text-spark">*</span>
                  <span className="sr-only"> required</span>
                </>
              )}
            </Label>
            <Input
              id="parent_email"
              type="email"
              autoComplete="email"
              required={parentEmailRequired}
              aria-required={parentEmailRequired || undefined}
              error={fieldErrors.parent_email}
              value={form.parent_email}
              onChange={(e) => set("parent_email", e.target.value)}
              placeholder={
                parentEmailRequired
                  ? "Required — you're under 18"
                  : "Optional — only needed if you're under 18"
              }
            />
            <FieldError id="parent_email-error">
              {fieldErrors.parent_email}
            </FieldError>
            <p className="mt-1 text-xs text-white/55">
              For applicants under 18, we email your parent/guardian a
              short note about the program once you submit.
            </p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="experience">
              Tell us about your relevant experience
            </Label>
            <Textarea
              id="experience"
              rows={5}
              value={form.experience}
              onChange={(e) => set("experience", e.target.value)}
              placeholder="Past projects, clubs, jobs, hackathons, side hustles — anything."
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="hours_per_week">
                Hours per week you can commit
              </Label>
              <Input
                id="hours_per_week"
                type="number"
                inputMode="numeric"
                min={0}
                max={168}
                value={form.hours_per_week}
                onChange={(e) => set("hours_per_week", e.target.value)}
                placeholder="10"
              />
            </div>
            <div>
              <Label htmlFor="referral_source">
                How did you hear about us?
              </Label>
              <Input
                id="referral_source"
                value={form.referral_source}
                onChange={(e) => set("referral_source", e.target.value)}
              />
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-spark">
              Links (optional)
            </p>
            <p className="mt-1 text-xs text-white/55">
              Anything that helps us see what you've built.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <Label htmlFor="linkedin_url">LinkedIn</Label>
                <Input
                  id="linkedin_url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://linkedin.com/in/…"
                  error={fieldErrors.linkedin_url}
                  value={form.linkedin_url}
                  onChange={(e) => set("linkedin_url", e.target.value)}
                />
                <FieldError id="linkedin_url-error">
                  {fieldErrors.linkedin_url}
                </FieldError>
              </div>
              <div>
                <Label htmlFor="resume_url">Resume URL</Label>
                <Input
                  id="resume_url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://… (Google Drive, Dropbox, your site)"
                  error={fieldErrors.resume_url}
                  value={form.resume_url}
                  onChange={(e) => set("resume_url", e.target.value)}
                />
                <FieldError id="resume_url-error">
                  {fieldErrors.resume_url}
                </FieldError>
              </div>
              <div>
                <Label htmlFor="portfolio_url">Portfolio / project link</Label>
                <Input
                  id="portfolio_url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://…"
                  error={fieldErrors.portfolio_url}
                  value={form.portfolio_url}
                  onChange={(e) => set("portfolio_url", e.target.value)}
                />
                <FieldError id="portfolio_url-error">
                  {fieldErrors.portfolio_url}
                </FieldError>
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="why_join" required>
              Why SparkLine? <span aria-hidden className="text-spark">*</span>
            </Label>
            <Textarea
              id="why_join"
              rows={6}
              required
              aria-required="true"
              error={fieldErrors.why_join}
              aria-describedby="why_join-counter"
              value={form.why_join}
              onChange={(e) => set("why_join", e.target.value)}
              placeholder="What do you want to get out of these 4 weeks?"
            />
            <div className="mt-1 flex items-center justify-between text-xs">
              <FieldError id="why_join-error">{fieldErrors.why_join}</FieldError>
              <span id="why_join-counter" className="text-white/50">
                {form.why_join.trim().length} / 40+ chars
              </span>
            </div>
          </div>
          <div>
            <Label htmlFor="startup_idea">
              Do you have a startup idea? (optional)
            </Label>
            <Textarea
              id="startup_idea"
              rows={6}
              value={form.startup_idea}
              onChange={(e) => set("startup_idea", e.target.value)}
              placeholder="It's totally fine if you don't. Tell us anything you've been thinking about."
            />
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-black/30 p-5 text-sm">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-spark">
              Review your answers
            </h4>
            <ReviewRow label="Full name" value={form.full_name} />
            <ReviewRow label="Age" value={form.age} />
            <ReviewRow label="Grade" value={form.grade} />
            <ReviewRow label="School" value={form.school} />
            <ReviewRow
              label="Location"
              value={[form.city, form.country].filter(Boolean).join(", ")}
            />
            <ReviewRow label="Parent email" value={form.parent_email} />
            <ReviewRow label="Hours/week" value={form.hours_per_week} />
            <ReviewRow label="Heard about us" value={form.referral_source} />
            <ReviewRow label="LinkedIn" value={form.linkedin_url} />
            <ReviewRow label="Resume" value={form.resume_url} />
            <ReviewRow label="Portfolio" value={form.portfolio_url} />
            <ReviewRow label="Why SparkLine" value={form.why_join} multiline />
            <ReviewRow label="Startup idea" value={form.startup_idea} multiline />
            <ReviewRow label="Experience" value={form.experience} multiline />
          </div>
          <div className="rounded-xl border border-spark/30 bg-spark/5 p-4 text-sm text-white/70">
            Submitting moves your application to{" "}
            <span className="text-white">review</span>. You won't be charged
            anything yet — payment ({priceLabel}) only happens after we accept
            you.
          </div>
        </div>
      )}

      {submitError && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200"
        >
          {submitError}
        </div>
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
            <Button
              type="button"
              onClick={goNext}
              disabled={submitPending || stepHasErrors(step)}
              title={
                stepHasErrors(step)
                  ? "Complete required fields to continue"
                  : undefined
              }
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
      <span className="inline-flex items-center gap-1.5 text-xs text-white/65">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving draft…
      </span>
    ) : status.kind === "saved" ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
        <Check className="h-3 w-3" aria-hidden /> Draft saved at{" "}
        {status.at.toLocaleTimeString()}
      </span>
    ) : status.kind === "error" ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-300">
        <AlertCircle className="h-3 w-3" aria-hidden /> {status.message}
      </span>
    ) : (
      <span className="text-xs text-white/45">
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
      className={`flex ${multiline ? "flex-col gap-1" : "items-baseline gap-3"} border-b border-white/5 py-2 last:border-0`}
    >
      <div className="text-xs uppercase tracking-wider text-white/55">
        {label}
      </div>
      <div
        className={`text-white/85 ${multiline ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "truncate"}`}
      >
        {value || <span className="text-white/40">—</span>}
      </div>
    </div>
  );
}
