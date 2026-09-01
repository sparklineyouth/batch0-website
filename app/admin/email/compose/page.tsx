import { createAdminClient } from "@/lib/supabase/admin";
import { listTemplates } from "@/lib/email/store";
import { ComposeForm, type ComposeTemplate, type ComposeCohort } from "./compose-form";

export const metadata = { title: "Compose email · Admin" };
export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const admin = createAdminClient();
  const [{ templates }, { data: cohorts }] = await Promise.all([
    listTemplates(),
    admin.from("cohorts").select("id, name").order("starts_on", { ascending: false }),
  ]);

  return (
    <ComposeForm
      // Disabled templates are offered here on purpose: "disabled" means
      // automations skip it, not that a human can't choose to send it.
      templates={templates.map<ComposeTemplate>((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
      }))}
      cohorts={(cohorts ?? []) as ComposeCohort[]}
    />
  );
}
