import { createClient } from "@/lib/supabase/server";
import type { Role, ApplicationStatus } from "@/lib/types";

const ACCEPTED_STATUSES: ApplicationStatus[] = ["accepted", "paid", "enrolled"];

/**
 * Whether the current user is allowed to access the AI co-founder.
 * Staff always have access. Students need an application that has
 * passed admin review (accepted / paid / enrolled).
 */
export async function canUseAi(role: Role): Promise<boolean> {
  if (
    role === "admin" ||
    role === "mentor" ||
    role === "investor"
  ) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: app } = await supabase
    .from("applications")
    .select("status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!app) return false;
  return ACCEPTED_STATUSES.includes(app.status as ApplicationStatus);
}
