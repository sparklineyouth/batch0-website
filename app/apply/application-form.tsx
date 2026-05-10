"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { saveDraftAction, submitApplicationAction } from "./actions";
import type { Application } from "@/lib/types";

const STEPS = [
  { id: 1, title: "About you" },
  { id: 2, title: "Background" },
  { id: 3, title: "Your idea" },
  { id: 4, title: "Review & submit" },
];

export function ApplicationForm({
  defaults,
  email,
}: {
  defaults: Application | null;
  email: string;
}) {
  const [step, setStep] = useState(1);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // Local form state — keeps fields populated across step nav
  const [form, setForm] = useState({
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
  });

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => ({ ...e, [k]: "" }));
  }

  function buildFormData() {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    return fd;
  }

  function handleSaveDraft() {
    setError(undefined);
    startTransition(async () => {
      const result = await saveDraftAction(null, buildFormData());
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setSavedAt(new Date());
    });
  }

  function handleSubmit() {
    setError(undefined);
    startTransition(async () => {
      const result = await submitApplicationAction(null, buildFormData());
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/40 p-6 md:p-8">
      {/* Stepper */}
      <ol className="mb-8 flex flex-wrap items-center gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep(s.id)}
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-medium ${
                step === s.id
                  ? "border-spark bg-spark text-black"
                  : step > s.id
                  ? "border-spark/40 bg-spark/10 text-spark"
                  : "border-white/15 text-white/40"
              }`}
            >
              {s.id}
            </button>
            <span className={step === s.id ? "text-white" : "text-white/40"}>
              {s.title}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 text-white/20">›</span>}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label>Account email</Label>
            <Input value={email} disabled />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="full_name">Full name *</Label>
            <Input
              id="full_name"
              value={form.full_name}
              onChange={(e) => set("full_name", e.target.value)}
            />
            <FieldError>{fieldErrors.full_name}</FieldError>
          </div>
          <div>
            <Label htmlFor="age">Age *</Label>
            <Input
              id="age"
              type="number"
              value={form.age}
              onChange={(e) => set("age", e.target.value)}
            />
            <FieldError>{fieldErrors.age}</FieldError>
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
              value={form.school}
              onChange={(e) => set("school", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="country">Country</Label>
            <Input
              id="country"
              value={form.country}
              onChange={(e) => set("country", e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="parent_email">Parent / guardian email</Label>
            <Input
              id="parent_email"
              type="email"
              value={form.parent_email}
              onChange={(e) => set("parent_email", e.target.value)}
              placeholder="Required if you're under 18"
            />
            <FieldError>{fieldErrors.parent_email}</FieldError>
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
          <div>
            <Label htmlFor="hours_per_week">
              Hours per week you can commit
            </Label>
            <Input
              id="hours_per_week"
              type="number"
              value={form.hours_per_week}
              onChange={(e) => set("hours_per_week", e.target.value)}
              placeholder="10"
            />
          </div>
          <div>
            <Label htmlFor="referral_source">How did you hear about us?</Label>
            <Input
              id="referral_source"
              value={form.referral_source}
              onChange={(e) => set("referral_source", e.target.value)}
            />
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="why_join">Why SparkLine? *</Label>
            <Textarea
              id="why_join"
              rows={6}
              value={form.why_join}
              onChange={(e) => set("why_join", e.target.value)}
              placeholder="What do you want to get out of these 4 weeks?"
            />
            <FieldError>{fieldErrors.why_join}</FieldError>
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
            <ReviewRow label="Location" value={[form.city, form.country].filter(Boolean).join(", ")} />
            <ReviewRow label="Parent email" value={form.parent_email} />
            <ReviewRow label="Hours/week" value={form.hours_per_week} />
            <ReviewRow label="Heard about us" value={form.referral_source} />
            <ReviewRow label="Why SparkLine" value={form.why_join} multiline />
            <ReviewRow label="Startup idea" value={form.startup_idea} multiline />
            <ReviewRow label="Experience" value={form.experience} multiline />
          </div>
          <div className="rounded-xl border border-spark/30 bg-spark/5 p-4 text-sm text-white/70">
            Submitting moves your application to <span className="text-white">review</span>. You won't be charged anything yet — payment ($97) only happens after we accept you.
          </div>
        </div>
      )}

      {error && (
        <div className="mt-5 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-white/40">
          {savedAt && `Draft saved at ${savedAt.toLocaleTimeString()}`}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            type="button"
            onClick={handleSaveDraft}
            disabled={pending}
          >
            Save draft
          </Button>
          {step > 1 && (
            <Button
              variant="secondary"
              type="button"
              onClick={() => setStep(step - 1)}
              disabled={pending}
            >
              Back
            </Button>
          )}
          {step < STEPS.length ? (
            <Button type="button" onClick={() => setStep(step + 1)} disabled={pending}>
              Next
            </Button>
          ) : (
            <Button type="button" onClick={handleSubmit} disabled={pending}>
              {pending ? "Submitting…" : "Submit application"}
            </Button>
          )}
        </div>
      </div>
    </div>
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
    <div className={`flex ${multiline ? "flex-col gap-1" : "items-baseline gap-3"} border-b border-white/5 py-2 last:border-0`}>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className={`text-white/80 ${multiline ? "whitespace-pre-wrap" : "truncate"}`}>
        {value || <span className="text-white/30">—</span>}
      </div>
    </div>
  );
}
