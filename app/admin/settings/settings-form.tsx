"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { saveSiteSettings, type SiteSettingsInput } from "./actions";
import { Toggle } from "@/components/ui/toggle";

type Cohort = { id: string; name: string; status: string };

export function SettingsForm({
  initial,
  cohorts,
}: {
  initial: SiteSettingsInput;
  cohorts: Cohort[];
}) {
  const [values, setValues] = useState<SiteSettingsInput>(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function set<K extends keyof SiteSettingsInput>(
    key: K,
    value: SiteSettingsInput[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    start(async () => {
      try {
        // Mirror selected cohort name into active_cohort_name for convenience
        // so the marketing site doesn't have to join.
        const activeCohort =
          cohorts.find((c) => c.id === values.active_cohort_id) ?? null;
        const payload: SiteSettingsInput = {
          ...values,
          active_cohort_name: activeCohort?.name ?? null,
          contact_email: values.contact_email.trim(),
          discord_url: values.discord_url.trim(),
        };
        await saveSiteSettings(payload);
        setValues(payload);
        setSaved(true);
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <Section title="Contact">
        <Field label="Contact email">
          <Input
            type="email"
            value={values.contact_email}
            onChange={(e) => set("contact_email", e.target.value)}
            placeholder="sparkline.youth@gmail.com"
          />
          <Hint>Shown in the footer and CTA. Where applicants can reach you.</Hint>
        </Field>
        <Field label="Discord invite URL">
          <Input
            type="url"
            value={values.discord_url}
            onChange={(e) => set("discord_url", e.target.value)}
            placeholder="https://discord.gg/…"
          />
          <Hint>Optional. Linked to enrolled students after payment.</Hint>
        </Field>
      </Section>

      <Section title="Applications">
        <Toggle
          label="Applications open"
          description="Master switch. When off, the application form is closed and the message below is shown."
          checked={values.applications_open}
          onChange={(v) => set("applications_open", v)}
        />
        <Field label="Active cohort">
          <Select
            value={values.active_cohort_id ?? ""}
            onChange={(e) =>
              set("active_cohort_id", e.target.value || null)
            }
          >
            <option value="">— Auto (next upcoming) —</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.status}
              </option>
            ))}
          </Select>
          <Hint>
            New applications get attached to this cohort. Leave blank to use
            the next upcoming cohort.
          </Hint>
        </Field>
        <Field label="Closed-message text">
          <Textarea
            rows={3}
            value={values.applications_closed_message}
            onChange={(e) =>
              set("applications_closed_message", e.target.value)
            }
            placeholder="Applications are currently closed."
          />
          <Hint>Shown on /apply when applications_open is off.</Hint>
        </Field>
      </Section>

      <Section title="Program">
        <Field label="Demo Day date">
          <Input
            type="date"
            value={values.demo_day_date ?? ""}
            onChange={(e) => set("demo_day_date", e.target.value || null)}
          />
          <Hint>Surfaced to enrolled students in the dashboard.</Hint>
        </Field>
      </Section>

      <Section title="Site">
        <Toggle
          label="Maintenance mode"
          description="When on, public marketing pages can show a maintenance banner. Auth and dashboards stay reachable."
          checked={values.maintenance_mode}
          onChange={(v) => set("maintenance_mode", v)}
        />
      </Section>

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-spark">
        {title}
      </h3>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-xs text-white/40">{children}</p>;
}
