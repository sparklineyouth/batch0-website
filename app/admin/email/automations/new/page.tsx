import { createAdminClient } from "@/lib/supabase/admin";
import { listTemplates } from "@/lib/email/store";
import { AutomationEditor, type TemplateOption, type CohortOption } from "../automation-editor";
import type { AutomationInput } from "../actions";

export const metadata = { title: "New email automation · Admin" };
export const dynamic = "force-dynamic";

/**
 * A new automation starts paused with one empty step.
 *
 * Paused because the save button on a form that sends real mail should not
 * also be the switch that starts sending it — an admin gets to look at what
 * they built, run it once by hand if they like, and turn it on deliberately.
 */
const BLANK: AutomationInput = {
  name: "",
  description: "",
  triggerType: "event",
  eventKey: "",
  scheduleCron: "0 14 * * 1",
  segment: "students",
  cohortId: "",
  includeParents: false,
  dedupeWindowHours: 24,
  enabled: false,
  steps: [{ templateId: "", delayMinutes: 0, condition: "always", enabled: true }],
};

export default async function NewAutomationPage() {
  const admin = createAdminClient();
  const [{ templates }, { data: cohorts }] = await Promise.all([
    listTemplates(),
    admin.from("cohorts").select("id, name").order("starts_on", { ascending: false }),
  ]);

  return (
    <AutomationEditor
      initial={BLANK}
      templates={templates.map<TemplateOption>((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        enabled: t.enabled,
      }))}
      cohorts={(cohorts ?? []) as CohortOption[]}
    />
  );
}
