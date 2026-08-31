import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAutomation, listTemplates } from "@/lib/email/store";
import { parseCondition } from "@/lib/email/conditions";
import { isAudienceSegment } from "@/lib/email/catalog";
import {
  AutomationEditor,
  type TemplateOption,
  type CohortOption,
} from "../automation-editor";
import type { AutomationInput } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const a = await getAutomation(params.id);
  return {
    title: a ? `${a.name} · Email automations · Admin` : "Email automation · Admin",
  };
}

export default async function AutomationPage({
  params,
}: {
  params: { id: string };
}) {
  const a = await getAutomation(params.id);
  if (!a) notFound();

  const admin = createAdminClient();
  const [{ templates }, { data: cohorts }] = await Promise.all([
    listTemplates(),
    admin.from("cohorts").select("id, name").order("starts_on", { ascending: false }),
  ]);

  const audience = (a.audience ?? {}) as Record<string, any>;
  const initial: AutomationInput = {
    id: a.id,
    name: a.name,
    description: a.description ?? "",
    triggerType: a.trigger_type,
    eventKey: a.event_key ?? "",
    scheduleCron: a.schedule_cron ?? "0 14 * * 1",
    // A stored segment that's since been removed from the catalog would
    // otherwise render as a blank select that silently saves back as blank.
    segment: isAudienceSegment(audience.segment) ? audience.segment : "students",
    cohortId: audience.cohortId ?? "",
    includeParents: Boolean(audience.includeParents),
    dedupeWindowHours: a.dedupe_window_hours,
    enabled: a.enabled,
    steps: a.steps.map((s) => ({
      templateId: s.template_id,
      delayMinutes: s.delay_minutes,
      condition: parseCondition(s.condition),
      enabled: s.enabled,
    })),
  };

  return (
    <AutomationEditor
      initial={initial}
      templates={templates.map<TemplateOption>((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        enabled: t.enabled,
      }))}
      cohorts={(cohorts ?? []) as CohortOption[]}
      lastRunAt={a.last_run_at}
      lastError={a.last_error}
    />
  );
}
