"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertSelf } from "@/lib/server-guards";
import { createClient } from "@/lib/supabase/server";
import type { InvestorInterestLevel } from "@/lib/types";

const VALID: InvestorInterestLevel[] = [
  "watching",
  "interested",
  "committed",
  "passed",
];

async function ensureInvestorOrAdmin() {
  const { userId } = await assertSelf();
  const supabase = createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (!profile || (profile.role !== "investor" && profile.role !== "admin")) {
    throw new Error("Forbidden");
  }
  return userId;
}

export async function setInterest(
  teamId: string,
  level: InvestorInterestLevel | null,
  notes?: string,
) {
  const userId = await ensureInvestorOrAdmin();
  const admin = createAdminClient();

  if (level === null) {
    await admin
      .from("investor_interests")
      .delete()
      .eq("investor_id", userId)
      .eq("team_id", teamId);
  } else {
    if (!VALID.includes(level)) throw new Error("Invalid level");
    await admin.from("investor_interests").upsert(
      {
        investor_id: userId,
        team_id: teamId,
        level,
        notes: notes?.trim() || null,
      },
      { onConflict: "investor_id,team_id" },
    );
  }
  revalidatePath("/investor/teams");
  revalidatePath("/investor/interests");
  revalidatePath("/investor");
}
