"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertStaff } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export type HolderKind = "founder" | "option" | "safe" | "investor" | "advisor";

export type HolderInput = {
  id?: string;
  team_id: string;
  profile_id: string | null;
  display_name: string;
  kind: HolderKind;
  shares_bp: number | null;
  amount_cents: number | null;
  valuation_cap_cents: number | null;
  discount_pct: number | null;
  vesting_start: string | null;
  vesting_months: number | null;
  cliff_months: number | null;
  notes: string | null;
};

function clean(input: HolderInput) {
  if (!input.display_name.trim()) throw new Error("Name is required");
  if (!input.team_id) throw new Error("Team is required");
  return {
    team_id: input.team_id,
    profile_id: input.profile_id || null,
    display_name: input.display_name.trim(),
    kind: input.kind,
    shares_bp: input.shares_bp,
    amount_cents: input.amount_cents,
    valuation_cap_cents: input.valuation_cap_cents,
    discount_pct: input.discount_pct,
    vesting_start: input.vesting_start || null,
    vesting_months: input.vesting_months,
    cliff_months: input.cliff_months,
    notes: input.notes?.trim() || null,
  };
}

export async function upsertHolder(input: HolderInput): Promise<string> {
  await assertStaff();
  const admin = createAdminClient();
  const row = clean(input);
  if (input.id) {
    const { error } = await admin
      .from("cap_table_holders")
      .update(row)
      .eq("id", input.id);
    if (error) throw new Error(error.message);
    await logAudit({
      action: "cap_table.holder_updated",
      targetType: "team",
      targetId: input.team_id,
      payload: { id: input.id, name: row.display_name },
    });
    revalidatePath(`/admin/teams/${input.team_id}`);
    return input.id;
  }
  const { data, error } = await admin
    .from("cap_table_holders")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await logAudit({
    action: "cap_table.holder_added",
    targetType: "team",
    targetId: input.team_id,
    payload: { id: data!.id, name: row.display_name, kind: row.kind },
  });
  revalidatePath(`/admin/teams/${input.team_id}`);
  return data!.id;
}

export async function deleteHolder(id: string, teamId: string) {
  await assertStaff();
  const admin = createAdminClient();
  const { error } = await admin
    .from("cap_table_holders")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "cap_table.holder_deleted",
    targetType: "team",
    targetId: teamId,
    payload: { id },
  });
  revalidatePath(`/admin/teams/${teamId}`);
}
