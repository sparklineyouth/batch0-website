"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import {
  slugify,
  type FlowMeta,
  type FlowStepData,
  type StepKind,
} from "@/lib/flows";

export type FlowSaveInput = {
  flow: FlowMeta;
  /** Steps in display order — array index becomes sort_order. */
  steps: FlowStepData[];
};

const KINDS: StepKind[] = ["content", "choice", "input", "checklist", "outcome"];
const STAGES = ["explore", "prove", "prepare"];
const STATUSES = ["draft", "published", "archived"];
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validate the whole flow before writing anything: unique step keys, legal
 * kinds, and — the one that saves admins from shipping a broken flow —
 * every branch target must point at a step that exists.
 */
function validate(input: FlowSaveInput): string {
  const { flow, steps } = input;
  if (!flow.title?.trim()) throw new Error("Title is required");
  const slug = (flow.slug?.trim() || slugify(flow.title)).toLowerCase();
  if (!KEY_RE.test(slug)) {
    throw new Error("Slug must be lowercase letters, numbers, and dashes");
  }
  if (!STAGES.includes(flow.stage)) throw new Error("Pick a stage");
  if (!STATUSES.includes(flow.status)) throw new Error("Pick a status");
  if (!steps?.length) throw new Error("Add at least one step");

  const keys = new Set<string>();
  for (const s of steps) {
    const k = s.step_key?.trim();
    if (!k || !KEY_RE.test(k)) {
      throw new Error(
        `Step key "${s.step_key}" must be lowercase letters, numbers, dashes`,
      );
    }
    if (keys.has(k)) throw new Error(`Duplicate step key "${k}"`);
    keys.add(k);
    if (!KINDS.includes(s.kind)) throw new Error("Unknown step kind");
  }

  for (const s of steps) {
    const c = s.config ?? {};
    const targets = [
      c.next,
      ...(c.options ?? []).map((o) => o.next),
    ].filter(Boolean) as string[];
    for (const t of targets) {
      if (!keys.has(t)) {
        throw new Error(`Step "${s.step_key}" jumps to unknown step "${t}"`);
      }
    }
    if (s.kind === "choice" && !c.options?.length) {
      throw new Error(`Choice step "${s.step_key}" needs at least one option`);
    }
    if (s.kind === "choice") {
      const vals = new Set<string>();
      for (const o of c.options ?? []) {
        if (!o.label?.trim() || !o.value?.trim()) {
          throw new Error(
            `Every option on "${s.step_key}" needs a label and value`,
          );
        }
        if (vals.has(o.value)) {
          throw new Error(`Duplicate option value on "${s.step_key}"`);
        }
        vals.add(o.value);
      }
    }
    if (s.kind === "input" && !c.fields?.length) {
      throw new Error(`Input step "${s.step_key}" needs at least one field`);
    }
    if (s.kind === "input") {
      const fk = new Set<string>();
      for (const f of c.fields ?? []) {
        if (!f.key?.trim() || !f.label?.trim()) {
          throw new Error(`Every field on "${s.step_key}" needs a key and label`);
        }
        if (fk.has(f.key)) {
          throw new Error(`Duplicate field key on "${s.step_key}"`);
        }
        fk.add(f.key);
      }
    }
    if (s.kind === "checklist" && !c.items?.length) {
      throw new Error(`Checklist step "${s.step_key}" needs at least one item`);
    }
    for (const b of c.blocks ?? []) {
      if (b.when && !keys.has(b.when.step)) {
        throw new Error(
          `An outcome block on "${s.step_key}" references unknown step "${b.when.step}"`,
        );
      }
    }
  }
  return slug;
}

export async function saveFlow(input: FlowSaveInput): Promise<string> {
  const { userId } = await assertAdmin();
  const slug = validate(input);

  const admin = createAdminClient();
  const meta = {
    slug,
    title: input.flow.title.trim(),
    tagline: input.flow.tagline?.trim() || null,
    stage: input.flow.stage,
    status: input.flow.status,
    est_minutes: input.flow.est_minutes || null,
    sort_order: input.flow.sort_order ?? 0,
    cohort_id: input.flow.cohort_id || null,
    updated_at: new Date().toISOString(),
  };

  let id = input.flow.id;
  if (id) {
    const { error } = await admin.from("flows").update(meta).eq("id", id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await admin
      .from("flows")
      .insert({ ...meta, created_by: userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = created!.id;
  }

  // Steps are replaced as a set: upsert by (flow_id, step_key), then drop
  // whatever the admin removed. Keys are validated above, so the in-list
  // filter below is safe.
  const rows = input.steps.map((s, i) => ({
    flow_id: id!,
    step_key: s.step_key.trim(),
    title: s.title?.trim() || null,
    kind: s.kind,
    body: s.body || null,
    config: s.config ?? {},
    sort_order: i,
  }));
  const { error: stepErr } = await admin
    .from("flow_steps")
    .upsert(rows, { onConflict: "flow_id,step_key" });
  if (stepErr) throw new Error(stepErr.message);

  const keep = rows.map((r) => r.step_key);
  const { error: delErr } = await admin
    .from("flow_steps")
    .delete()
    .eq("flow_id", id!)
    .not("step_key", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
  if (delErr) throw new Error(delErr.message);

  await logAudit({
    action: input.flow.id ? "flow.updated" : "flow.created",
    targetType: "flow",
    targetId: id ?? null,
    payload: { title: meta.title, slug, status: meta.status },
  });

  revalidatePath("/admin/flows");
  revalidatePath("/dashboard/resources");
  revalidatePath(`/dashboard/resources/flow/${slug}`);
  return id!;
}

export async function deleteFlow(id: string): Promise<void> {
  await assertAdmin();
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("flows")
    .select("title, slug")
    .eq("id", id)
    .maybeSingle();
  const { error } = await admin.from("flows").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "flow.deleted",
    targetType: "flow",
    targetId: id,
    payload: { title: existing?.title ?? null },
  });
  revalidatePath("/admin/flows");
  revalidatePath("/dashboard/resources");
}
