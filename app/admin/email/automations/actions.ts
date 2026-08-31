"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { cronError, parseCron, nextRun } from "@/lib/email/cron";
import { conditionValue } from "@/lib/email/conditions";
import { getAutomation } from "@/lib/email/store";
import { fanOutScheduled } from "@/lib/email/queue";
import { countAudience } from "@/lib/email/audience";
import {
  eventDef,
  isAudienceSegment,
  isStepCondition,
  type AudienceSegment,
  type StepConditionKind,
} from "@/lib/email/catalog";

/**
 * Automation CRUD.
 *
 * The steps are saved as a full replacement rather than a diff. It costs a
 * delete plus an insert on every save, which is nothing at this size, and it
 * removes the entire class of bug where reordering or removing a step leaves
 * an orphan row that still sends. Rows already queued reference the step by
 * id, so a replaced step id means those queued rows lose their gate — which
 * is why the drainer treats a missing step as "no condition, send" rather
 * than as a failure.
 */

export type StepInput = {
  templateId: string;
  delayMinutes: number;
  condition: StepConditionKind;
  enabled: boolean;
};

export type AutomationInput = {
  id?: string;
  name: string;
  description: string;
  triggerType: "event" | "schedule" | "manual";
  eventKey: string;
  scheduleCron: string;
  segment: AudienceSegment;
  cohortId: string;
  includeParents: boolean;
  dedupeWindowHours: number;
  enabled: boolean;
  steps: StepInput[];
};

export type SaveResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

function validate(
  input: AutomationInput,
): { ok: true } | { ok: false; error: string } {
  if (!input.name.trim()) return { ok: false, error: "Give the automation a name." };

  if (input.triggerType === "event") {
    if (!input.eventKey) return { ok: false, error: "Pick a trigger event." };
    if (!eventDef(input.eventKey)) {
      return { ok: false, error: "That trigger event no longer exists." };
    }
  }
  if (input.triggerType === "schedule") {
    const err = cronError(input.scheduleCron ?? "");
    if (err) return { ok: false, error: `Schedule: ${err}` };
    if (!isAudienceSegment(input.segment)) {
      return { ok: false, error: "Pick an audience for the schedule." };
    }
  }
  if (input.triggerType === "manual" && !isAudienceSegment(input.segment)) {
    return { ok: false, error: "Pick an audience." };
  }

  const steps = (input.steps ?? []).filter((s) => s.templateId);
  if (steps.length === 0) {
    return { ok: false, error: "Add at least one step with a template." };
  }
  for (const s of steps) {
    if (!Number.isInteger(s.delayMinutes) || s.delayMinutes < 0) {
      return { ok: false, error: "Step delays must be zero or more minutes." };
    }
    if (!isStepCondition(s.condition)) {
      return { ok: false, error: "Unknown step condition." };
    }
  }
  // Two steps at the same delay against the same template send the same
  // person the same email twice at the same moment. Always a mistake.
  const seen = new Set<string>();
  for (const s of steps) {
    const sig = `${s.templateId}@${s.delayMinutes}`;
    if (seen.has(sig)) {
      return {
        ok: false,
        error: "Two steps use the same template at the same delay — that sends a duplicate.",
      };
    }
    seen.add(sig);
  }
  if (
    !Number.isInteger(input.dedupeWindowHours) ||
    input.dedupeWindowHours < 0 ||
    input.dedupeWindowHours > 24 * 90
  ) {
    return { ok: false, error: "The dedupe window must be between 0 and 2160 hours." };
  }
  return { ok: true };
}

export async function saveAutomation(
  input: AutomationInput,
): Promise<SaveResult> {
  const { userId } = await assertPermission("email.automate");
  const v = validate(input);
  if (!v.ok) return v;

  const admin = createAdminClient();
  const row = {
    name: input.name.trim(),
    description: input.description.trim() || null,
    trigger_type: input.triggerType,
    event_key: input.triggerType === "event" ? input.eventKey : null,
    schedule_cron:
      input.triggerType === "schedule" ? input.scheduleCron.trim() : null,
    audience:
      input.triggerType === "event"
        ? {}
        : {
            segment: input.segment,
            cohortId: input.cohortId || null,
            includeParents: input.includeParents,
          },
    enabled: input.enabled,
    dedupe_window_hours: input.dedupeWindowHours,
    updated_at: new Date().toISOString(),
  };

  let id = input.id;
  if (id) {
    const { error } = await admin
      .from("email_automations")
      .update(row)
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await admin
      .from("email_automations")
      .insert({ ...row, created_by: userId })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    id = data.id;
  }

  const { error: clearError } = await admin
    .from("email_automation_steps")
    .delete()
    .eq("automation_id", id);
  if (clearError) return { ok: false, error: clearError.message };

  const steps = (input.steps ?? []).filter((s) => s.templateId);
  const { error: stepError } = await admin.from("email_automation_steps").insert(
    steps.map((s, i) => ({
      automation_id: id,
      step_index: i,
      template_id: s.templateId,
      delay_minutes: s.delayMinutes,
      condition: conditionValue(s.condition),
      enabled: s.enabled,
    })),
  );
  if (stepError) return { ok: false, error: stepError.message };

  await logAudit({
    action: input.id ? "email.automation_updated" : "email.automation_created",
    targetType: "email_automation",
    targetId: id,
    payload: {
      name: row.name,
      trigger: input.triggerType,
      event: row.event_key,
      schedule: row.schedule_cron,
      steps: steps.length,
      enabled: input.enabled,
    },
  });

  revalidatePath("/admin/email/automations");
  revalidatePath(`/admin/email/automations/${id}`);
  return { ok: true, id: id! };
}

export async function setAutomationEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.automate");
  const admin = createAdminClient();
  const { error } = await admin
    .from("email_automations")
    .update({
      enabled,
      updated_at: new Date().toISOString(),
      // Re-enabling resets the schedule clock. Without this, a schedule
      // that's been off for a month would immediately look "due" and fire the
      // moment it comes back — the opposite of what turning it back on means.
      ...(enabled ? { last_run_at: new Date().toISOString(), last_error: null } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  await logAudit({
    action: enabled ? "email.automation_enabled" : "email.automation_disabled",
    targetType: "email_automation",
    targetId: id,
  });
  revalidatePath("/admin/email/automations");
  revalidatePath(`/admin/email/automations/${id}`);
  return { ok: true };
}

export async function deleteAutomation(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.automate");
  const admin = createAdminClient();

  // Cancel anything this automation has queued but not sent. Deleting the
  // automation and leaving its mail to go out later is the worst of both
  // worlds — the admin thinks it's stopped and the emails still arrive.
  const { count: canceled } = await admin
    .from("email_outbox")
    .update({ status: "canceled", last_error: "Automation deleted" }, { count: "exact" })
    .eq("automation_id", id)
    .eq("status", "pending");

  const { error } = await admin.from("email_automations").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  await logAudit({
    action: "email.automation_deleted",
    targetType: "email_automation",
    targetId: id,
    payload: { canceledQueued: canceled ?? 0 },
  });
  revalidatePath("/admin/email/automations");
  return { ok: true };
}

/** How many addresses an audience currently resolves to. */
export async function previewAudienceCount(
  segment: string,
  cohortId: string,
  includeParents: boolean,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  await assertPermission("email.automate");
  if (!isAudienceSegment(segment)) return { ok: false, error: "Unknown audience." };
  const count = await countAudience({
    segment,
    cohortId: cohortId || null,
    includeParents,
  });
  return { ok: true, count };
}

/** The next few times a schedule would fire, for the editor's sanity check. */
export async function previewSchedule(
  expr: string,
): Promise<{ ok: true; runs: string[] } | { ok: false; error: string }> {
  await assertPermission("email.automate");
  const err = cronError(expr);
  if (err) return { ok: false, error: err };
  const parsed = parseCron(expr);
  const runs: string[] = [];
  let cursor = new Date();
  for (let i = 0; i < 3; i++) {
    const next = nextRun(parsed, cursor);
    if (!next) break;
    runs.push(next.toISOString());
    cursor = next;
  }
  return { ok: true, runs };
}

/**
 * Run an automation now, against its configured audience.
 *
 * The confirmation this needs lives in the UI, not here — but note what it
 * does: it queues real mail to real people immediately. It's the button for a
 * manual automation, and an escape hatch for a scheduled one whose cron was
 * missed.
 */
export async function runAutomationNow(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  await assertPermission("email.send");
  const automation = await getAutomation(id);
  if (!automation) return { ok: false, message: "That automation is gone." };
  if (automation.trigger_type === "event") {
    return {
      ok: false,
      message:
        "Event automations fire when the event happens — there's no audience to run them against.",
    };
  }
  if (!automation.enabled) {
    return { ok: false, message: "Enable the automation first." };
  }

  try {
    const queued = await fanOutScheduled(automation, new Date());
    await logAudit({
      action: "email.automation_run_now",
      targetType: "email_automation",
      targetId: id,
      payload: { name: automation.name, queued },
    });
    revalidatePath("/admin/email/outbox");
    return {
      ok: true,
      message:
        queued === 0
          ? "Nothing queued — the audience is empty, or everyone already got this run."
          : `Queued ${queued} email${queued === 1 ? "" : "s"}. They send on the next queue run.`,
    };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? "Run failed." };
  }
}

