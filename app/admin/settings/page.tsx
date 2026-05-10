import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { SettingsForm } from "./settings-form";

export const metadata = { title: "Settings · Admin" };

export default async function AdminSettingsPage() {
  const admin = createAdminClient();
  const { data: rows } = await admin.from("site_settings").select("*");
  const settings: Record<string, any> = {};
  for (const r of rows ?? []) settings[r.key] = r.value;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Site settings</h1>
      <p className="mt-1 text-sm text-white/50">
        Site-wide configuration. Values are JSON.
      </p>
      <Card className="mt-6">
        <SettingsForm initial={settings} />
      </Card>
    </div>
  );
}
