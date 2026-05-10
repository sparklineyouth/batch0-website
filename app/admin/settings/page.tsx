import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { SettingsForm } from "./settings-form";
import type { SiteSettingsInput } from "./actions";

export const metadata = { title: "Settings · Admin" };

const DEFAULTS: SiteSettingsInput = {
  contact_email: "sparkline.youth@gmail.com",
  applications_open: true,
  applications_closed_message:
    "Applications are currently closed. Check back soon for the next cohort.",
  active_cohort_id: null,
  active_cohort_name: null,
  discord_url: "",
  demo_day_date: null,
  maintenance_mode: false,
};

export default async function AdminSettingsPage() {
  const admin = createAdminClient();
  const [{ data: rows }, { data: cohorts }] = await Promise.all([
    admin.from("site_settings").select("*"),
    admin
      .from("cohorts")
      .select("id, name, status")
      .order("starts_on", { ascending: false }),
  ]);

  const raw: Record<string, any> = {};
  for (const r of rows ?? []) raw[r.key] = r.value;

  const initial: SiteSettingsInput = {
    contact_email:
      typeof raw.contact_email === "string"
        ? raw.contact_email
        : DEFAULTS.contact_email,
    applications_open:
      typeof raw.applications_open === "boolean"
        ? raw.applications_open
        : DEFAULTS.applications_open,
    applications_closed_message:
      typeof raw.applications_closed_message === "string"
        ? raw.applications_closed_message
        : DEFAULTS.applications_closed_message,
    active_cohort_id:
      typeof raw.active_cohort_id === "string" ? raw.active_cohort_id : null,
    active_cohort_name:
      typeof raw.active_cohort_name === "string"
        ? raw.active_cohort_name
        : null,
    discord_url:
      typeof raw.discord_url === "string" ? raw.discord_url : "",
    demo_day_date:
      typeof raw.demo_day_date === "string" ? raw.demo_day_date : null,
    maintenance_mode:
      typeof raw.maintenance_mode === "boolean"
        ? raw.maintenance_mode
        : false,
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Site settings</h1>
      <p className="mt-1 text-sm text-white/50">
        Public-facing site config. Changes apply immediately.
      </p>
      <Card className="mt-6">
        <SettingsForm initial={initial} cohorts={cohorts ?? []} />
      </Card>
    </div>
  );
}
