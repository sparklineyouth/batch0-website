import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import type { VariableDef } from "@/lib/email/vars";
import type { StoredTemplate } from "@/lib/email/render";

/**
 * Reads against the email tables, with one rule running through all of them:
 * a missing table is never an error.
 *
 * Migration 0052 can lag the deploy — that's the normal state of a Supabase
 * project for the few minutes between `vercel --prod` and `supabase db push`,
 * and it's the permanent state of a fresh local checkout. During that window
 * every transactional send in the app still has to work, so these return
 * empty and the callers fall back to the compiled templates.
 */

export type TemplateRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  cta_label: string | null;
  cta_url: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  variables: VariableDef[] | null;
  is_system: boolean;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type AutomationRow = {
  id: string;
  name: string;
  description: string | null;
  trigger_type: "event" | "schedule" | "manual";
  event_key: string | null;
  schedule_cron: string | null;
  audience: Record<string, any>;
  enabled: boolean;
  dedupe_window_hours: number;
  last_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AutomationStepRow = {
  id: string;
  automation_id: string;
  step_index: number;
  template_id: string;
  delay_minutes: number;
  condition: Record<string, any>;
  enabled: boolean;
};

/** True when the failure is "migration 0052 hasn't run here yet". */
export function isMissingTable(error: { message?: string } | null): boolean {
  return Boolean(error?.message && /does not exist|schema cache/i.test(error.message));
}

export async function getTemplateByKey(key: string): Promise<TemplateRow | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_templates")
      .select("*")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      if (!isMissingTable(error)) {
        console.error("[email/store] template lookup failed", key, error.message);
      }
      return null;
    }
    return (data as TemplateRow) ?? null;
  } catch (err) {
    console.error("[email/store] template lookup threw", key, err);
    return null;
  }
}

export async function getTemplateById(id: string): Promise<TemplateRow | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("email_templates")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return (data as TemplateRow) ?? null;
  } catch {
    return null;
  }
}

export async function listTemplates(): Promise<{
  templates: TemplateRow[];
  missingTable: boolean;
}> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_templates")
      .select("*")
      .order("category")
      .order("name");
    if (error) return { templates: [], missingTable: isMissingTable(error) };
    return { templates: (data ?? []) as TemplateRow[], missingTable: false };
  } catch {
    return { templates: [], missingTable: true };
  }
}

export async function listAutomations(): Promise<{
  automations: (AutomationRow & { steps: AutomationStepRow[] })[];
  missingTable: boolean;
}> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_automations")
      .select("*, steps:email_automation_steps(*)")
      .order("created_at", { ascending: false });
    if (error) return { automations: [], missingTable: isMissingTable(error) };
    const rows = (data ?? []).map((a: any) => ({
      ...a,
      steps: [...(a.steps ?? [])].sort(
        (x: AutomationStepRow, y: AutomationStepRow) => x.step_index - y.step_index,
      ),
    }));
    return { automations: rows, missingTable: false };
  } catch {
    return { automations: [], missingTable: true };
  }
}

/**
 * React-cached: the page and its generateMetadata both need this, and the
 * admin Supabase client forces `cache: "no-store"`, so Next's own fetch dedupe
 * doesn't apply — without this it's two identical joined queries per render.
 */
export const getAutomation = cache(async function getAutomation(
  id: string,
): Promise<(AutomationRow & { steps: AutomationStepRow[] }) | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("email_automations")
      .select("*, steps:email_automation_steps(*)")
      .eq("id", id)
      .maybeSingle();
    if (!data) return null;
    return {
      ...(data as any),
      steps: [...((data as any).steps ?? [])].sort(
        (x: AutomationStepRow, y: AutomationStepRow) => x.step_index - y.step_index,
      ),
    };
  } catch {
    return null;
  }
});

/** Enabled event automations for one event key, steps in order. */
export async function automationsForEvent(
  eventKey: string,
): Promise<(AutomationRow & { steps: AutomationStepRow[] })[]> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_automations")
      .select("*, steps:email_automation_steps(*)")
      .eq("trigger_type", "event")
      .eq("event_key", eventKey)
      .eq("enabled", true);
    if (error) return [];
    return (data ?? []).map((a: any) => ({
      ...a,
      steps: [...(a.steps ?? [])]
        .filter((s: AutomationStepRow) => s.enabled)
        .sort((x: AutomationStepRow, y: AutomationStepRow) => x.step_index - y.step_index),
    }));
  } catch {
    return [];
  }
}

/** The subset of a row the renderer needs. */
export function toStoredTemplate(row: TemplateRow): StoredTemplate {
  return {
    id: row.id,
    key: row.key,
    subject: row.subject,
    preheader: row.preheader,
    body_html: row.body_html,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
    variables: row.variables ?? [],
    from_name: row.from_name,
    from_email: row.from_email,
    reply_to: row.reply_to,
  };
}
